import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import {
  buildAgencySummaries,
  buildAgencyUsers,
  isUuid,
  type HqAgencyRow,
  type HqEntitlementRow,
  type HqProfileRow,
  type HqRoleRow,
} from "./hq.core";

/**
 * Platform-owner authorization. The role is read through the caller's own
 * session (RLS: "Users can view own roles"), never from client input.
 */
async function assertPlatformOwner(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "platform_owner")
    .limit(1);

  if (error || !data || data.length === 0) {
    throw new Error("Forbidden: platform owner access required");
  }
}

/** All agencies with user counts, owner and plan. Platform owner only. */
export const getHqOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertPlatformOwner(supabase as never, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [agenciesRes, profilesRes, rolesRes, entRes] = await Promise.all([
      supabaseAdmin
        .from("agencies")
        .select("id, name, plan, created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      supabaseAdmin.from("profiles").select("id, agency_id, full_name, email, last_seen_at").limit(2000),
      supabaseAdmin.from("user_roles").select("user_id, agency_id, role").limit(4000),
      supabaseAdmin.from("agency_entitlements").select("agency_id, effective_plan, source").limit(500),
    ]);

    const agencies = buildAgencySummaries(
      (agenciesRes.data ?? []) as HqAgencyRow[],
      (profilesRes.data ?? []) as HqProfileRow[],
      (rolesRes.data ?? []) as HqRoleRow[],
      (entRes.data ?? []) as HqEntitlementRow[],
    );

    return { agencies };
  });

/** Users + recent login activity for one agency. Platform owner only. */
export const getHqAgencyDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { agencyId: string }) => {
    if (!isUuid(input?.agencyId)) throw new Error("Invalid agency selector");
    return { agencyId: input.agencyId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Authorization never depends on the requested agency id.
    await assertPlatformOwner(supabase as never, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [profilesRes, rolesRes, eventsRes] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, agency_id, full_name, email, last_seen_at")
        .eq("agency_id", data.agencyId)
        .limit(500),
      supabaseAdmin.from("user_roles").select("user_id, agency_id, role").eq("agency_id", data.agencyId).limit(1000),
      supabaseAdmin
        .from("login_events")
        .select("id, user_id, event_type, occurred_at")
        .eq("agency_id", data.agencyId)
        .order("occurred_at", { ascending: false })
        .limit(50),
    ]);

    const profiles = (profilesRes.data ?? []) as HqProfileRow[];
    const users = buildAgencyUsers(profiles, (rolesRes.data ?? []) as HqRoleRow[]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    const activity = (eventsRes.data ?? []).map((e) => ({
      id: e.id as string,
      userId: e.user_id as string,
      userName: nameById.get(e.user_id as string) ?? "(unknown user)",
      eventType: e.event_type as string,
      occurredAt: e.occurred_at as string,
    }));

    return { users, activity };
  });
