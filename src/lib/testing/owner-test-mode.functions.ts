import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import {
  canManageTestOverride,
  validateEnableRequest,
  type EnableTestOverrideInput,
} from "./owner-test-mode.core";

/** Owner Test Mode status + recent audit trail (owner-only for the audit). */
export const getOwnerTestMode = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { readOwnerTestOverride, resolveOwnerTestModeContext } = await import(
      "./owner-test-mode.server"
    );
    const { agencyId, roles } = await resolveOwnerTestModeContext(supabase, userId);
    const canManage = canManageTestOverride(roles);

    const state = await readOwnerTestOverride(supabase, agencyId);

    type AuditRow = {
      id: string;
      action: string;
      categories: string[] | null;
      reason: string | null;
      expires_at: string | null;
      created_at: string;
      actor_id: string | null;
    };
    let audit: AuditRow[] = [];
    if (canManage) {
      const { data } = await supabase
        .from("owner_test_override_events")
        .select("id, action, categories, reason, expires_at, created_at, actor_id")
        .eq("agency_id", agencyId)
        .order("created_at", { ascending: false })
        .limit(20);
      audit = (data ?? []) as AuditRow[];
    }

    return { state, canManage, audit };
  });

/**
 * Enable/disable Owner Test Mode. Owner-only, agency-scoped, confirmation and
 * reason required. Writes an immutable audit event. Touches no usage counter,
 * plan, entitlement or billing record.
 */
export const setOwnerTestMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { enabled: boolean } & EnableTestOverrideInput) => {
    if (!input || typeof input.enabled !== "boolean") {
      throw new Error("Owner Test Mode request is missing the enabled flag.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { readOwnerTestOverride, resolveOwnerTestModeContext } = await import(
      "./owner-test-mode.server"
    );
    const { agencyId, roles } = await resolveOwnerTestModeContext(supabase, userId);
    if (!canManageTestOverride(roles)) {
      throw new Error("Only the agency owner can change Owner Test Mode.");
    }

    if (data?.enabled) {
      const plan = validateEnableRequest(data);
      const { error } = await supabase.from("owner_test_overrides").upsert(
        {
          agency_id: agencyId,
          enabled: true,
          categories: plan.categories,
          reason: plan.reason,
          enabled_by: userId,
          enabled_at: new Date().toISOString(),
          expires_at: plan.expiresAt,
        },
        { onConflict: "agency_id" },
      );
      if (error) throw new Error(error.message);

      await supabase.from("owner_test_override_events").insert({
        agency_id: agencyId,
        actor_id: userId,
        action: "enabled",
        categories: plan.categories,
        reason: plan.reason,
        expires_at: plan.expiresAt,
      });
    } else {
      const { error } = await supabase.from("owner_test_overrides").upsert(
        {
          agency_id: agencyId,
          enabled: false,
          categories: [],
          reason: null,
          enabled_by: userId,
          enabled_at: null,
          expires_at: null,
        },
        { onConflict: "agency_id" },
      );
      if (error) throw new Error(error.message);

      await supabase.from("owner_test_override_events").insert({
        agency_id: agencyId,
        actor_id: userId,
        action: "disabled",
        categories: [],
        reason: typeof data?.reason === "string" ? data.reason.slice(0, 500) : null,
      });
    }

    return { state: await readOwnerTestOverride(supabase, agencyId) };
  });
