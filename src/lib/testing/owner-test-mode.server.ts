import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DISABLED_OVERRIDE_STATE,
  isOverrideActive,
  normalizeCategories,
  type OwnerTestOverrideState,
  type TestOverrideCategory,
} from "./owner-test-mode.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/** Resolve the authenticated user's agency and roles for owner-only controls. */
export async function resolveOwnerTestModeContext(
  supabase: Db,
  userId: string,
): Promise<{ agencyId: string; roles: string[] }> {
  const [{ data: profile, error: profileError }, { data: roleRows, error: rolesError }] =
    await Promise.all([
      supabase.from("profiles").select("agency_id").eq("id", userId).maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", userId),
    ]);

  if (profileError) throw new Error(profileError.message);
  if (rolesError) throw new Error(rolesError.message);

  const agencyId = (profile as { agency_id?: string | null } | null)?.agency_id;
  if (!agencyId) throw new Error("No agency found for this account");

  return {
    agencyId,
    roles: ((roleRows ?? []) as { role: string }[]).map(({ role }) => role),
  };
}

/**
 * OWNER TEST MODE — server read path.
 *
 * Only usage/allowance gates consult this. It never touches usage counters,
 * plans, entitlements or billing state.
 */
export async function readOwnerTestOverride(
  supabase: Db,
  agencyId: string,
): Promise<OwnerTestOverrideState> {
  const { data, error } = await supabase
    .from("owner_test_overrides")
    .select("enabled, categories, reason, enabled_at, expires_at, enabled_by")
    .eq("agency_id", agencyId)
    .maybeSingle();

  if (error || !data) return DISABLED_OVERRIDE_STATE;

  const row = data as {
    enabled: boolean | null;
    categories: unknown;
    reason: string | null;
    enabled_at: string | null;
    expires_at: string | null;
    enabled_by: string | null;
  };

  return {
    enabled: row.enabled === true,
    categories: normalizeCategories(row.categories),
    reason: row.reason ?? null,
    enabledAt: row.enabled_at ?? null,
    expiresAt: row.expires_at ?? null,
    enabledBy: row.enabled_by ?? null,
  };
}

/**
 * True only when this agency's owner has an active test override covering
 * `category`. Any failure resolves to `false` (normal enforcement wins).
 */
export async function isQuotaOverrideActive(
  supabase: Db,
  agencyId: string,
  category: TestOverrideCategory,
): Promise<boolean> {
  try {
    const state = await readOwnerTestOverride(supabase, agencyId);
    return isOverrideActive(state, category);
  } catch {
    return false;
  }
}
