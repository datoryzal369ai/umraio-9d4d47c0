/**
 * UMRAIO HQ — pure shaping helpers for the platform-owner visibility layer.
 *
 * No authorization happens here: every function in this module assumes the
 * caller has already been verified as a platform owner server-side.
 */

export type HqAgencyRow = {
  id: string;
  name: string;
  plan: string | null;
  created_at: string;
};

export type HqProfileRow = {
  id: string;
  agency_id: string | null;
  full_name: string | null;
  email: string | null;
  last_seen_at: string | null;
};

export type HqRoleRow = {
  user_id: string;
  agency_id: string | null;
  role: string;
};

export type HqEntitlementRow = {
  agency_id: string;
  effective_plan: string | null;
  source: string | null;
};

export type HqAgencySummary = {
  id: string;
  name: string;
  plan: string;
  planSource: string | null;
  createdAt: string;
  userCount: number;
  ownerName: string | null;
  ownerEmail: string | null;
};

export type HqUser = {
  id: string;
  name: string;
  email: string | null;
  roles: string[];
  lastSeenAt: string | null;
};

/** Role shown first when a user holds more than one. */
const ROLE_PRIORITY = ["platform_owner", "owner", "admin", "islamic_approver", "agent"];

export function sortRoles(roles: string[]): string[] {
  return [...new Set(roles)].sort((a, b) => {
    const ai = ROLE_PRIORITY.indexOf(a);
    const bi = ROLE_PRIORITY.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

export function rolesByUser(roles: HqRoleRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of roles) {
    const list = map.get(row.user_id) ?? [];
    list.push(row.role);
    map.set(row.user_id, sortRoles(list));
  }
  return map;
}

export function buildAgencySummaries(
  agencies: HqAgencyRow[],
  profiles: HqProfileRow[],
  roles: HqRoleRow[],
  entitlements: HqEntitlementRow[] = [],
): HqAgencySummary[] {
  const roleMap = rolesByUser(roles);
  const entMap = new Map(entitlements.map((e) => [e.agency_id, e]));

  return agencies.map((agency) => {
    const members = profiles.filter((p) => p.agency_id === agency.id);
    const owner =
      members.find((m) => (roleMap.get(m.id) ?? []).includes("owner")) ?? members[0] ?? null;
    const ent = entMap.get(agency.id);

    return {
      id: agency.id,
      name: agency.name,
      plan: ent?.effective_plan ?? agency.plan ?? "unknown",
      planSource: ent?.source ?? null,
      createdAt: agency.created_at,
      userCount: members.length,
      ownerName: owner?.full_name?.trim() || null,
      ownerEmail: owner?.email ?? null,
    };
  });
}

export function buildAgencyUsers(profiles: HqProfileRow[], roles: HqRoleRow[]): HqUser[] {
  const roleMap = rolesByUser(roles);
  return profiles
    .map((p) => ({
      id: p.id,
      name: p.full_name?.trim() || "(unnamed)",
      email: p.email,
      roles: roleMap.get(p.id) ?? [],
      lastSeenAt: p.last_seen_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A UUID is the only acceptable agency selector coming from the client. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
