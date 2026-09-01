/**
 * UMRAIO® — Agency Team / Invitation V1 (pure helpers).
 *
 * No authorization decisions are enforced here. Every rule in this module is
 * mirrored server-side by the SECURITY DEFINER functions
 * `create_agency_invitation` / `accept_agency_invitation`, which are the real
 * security boundary. These helpers exist for token shaping and UI gating.
 */

export const INVITABLE_ROLES = ["admin", "agent", "islamic_approver"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** owner + platform_owner are deliberately absent: never invitable. */
export function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === "string" && (INVITABLE_ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  agent: "Agent",
  islamic_approver: "Islamic Approver",
  platform_owner: "Founder",
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "Member";
  return ROLE_LABELS[role] ?? role;
}

/** Managers (owner/admin) may create and revoke invitations. */
export function canManageInvitations(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Only the owner may change roles or remove members. */
export function canManageMembers(role: string | null | undefined): boolean {
  return role === "owner";
}

/** Settings / team surfaces are hidden from agents (UI hint only, not a boundary). */
export function canSeeSettings(role: string | null | undefined): boolean {
  return role !== "agent";
}

/* ------------------------------------------------------------------ */
/* Role-aware navigation (presentation only — the server and RLS remain */
/* the sole authorization boundary).                                    */
/* ------------------------------------------------------------------ */

const AGENCY_ROLE_RANK: Record<string, number> = {
  owner: 0,
  admin: 1,
  islamic_approver: 2,
  agent: 3,
};

export function isPlatformOwner(roles: readonly string[] | null | undefined): boolean {
  return Array.isArray(roles) && roles.includes("platform_owner");
}

/**
 * Highest-privilege agency role held by the user. `platform_owner` is a
 * platform capability, not an agency role, so it never appears here — the
 * founder keeps their normal agency-owner capabilities.
 */
export function effectiveAgencyRole(roles: readonly string[] | null | undefined): string | null {
  const candidates = (roles ?? []).filter((r) => r in AGENCY_ROLE_RANK);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => AGENCY_ROLE_RANK[a]! - AGENCY_ROLE_RANK[b]!)[0]!;
}

/** Team management surface: owner and admin only. */
export function canSeeTeam(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Landing route after sign-in, derived from server-trusted roles only. */
export function homeRouteForRoles(roles: readonly string[] | null | undefined): string {
  if (isPlatformOwner(roles)) return "/hq";
  return "/dashboard";
}

/** Operational surfaces every signed-in agency member may see. */
const OPERATIONAL_NAV = new Set([
  "/dashboard",
  "/tasks",
  "/crm",
  "/leads",
  "/conversations",
  "/profile",
]);

/**
 * UI-only nav filter. Agents get the operational workspace; management and
 * billing surfaces stay with owner/admin. Islamic approvers keep the
 * operational workspace plus their existing governance surface.
 */
export function canSeeNavItem(role: string | null | undefined, to: string): boolean {
  if (OPERATIONAL_NAV.has(to)) return true;
  if (role === "agent") return false;
  if (role === "islamic_approver") return to.startsWith("/settings/governance") || to === "/knowledge";
  return true;
}


export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export const INVITATION_TTL_DAYS = 7;

export function invitationExpiry(now: number = Date.now()): string {
  return new Date(now + INVITATION_TTL_DAYS * 86_400_000).toISOString();
}

/** 256-bit URL-safe token. The raw value is shown once and never stored. */
export function generateInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** SHA-256 hex. Only this value ever reaches the database. */
export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/join/${token}`;
}

/** Single generic response: never reveals whether a token exists or its state. */
export const INVITATION_INVALID_MESSAGE =
  "This invitation link is not valid. Ask your agency owner to send a new one.";

/* ------------------------------------------------------------------ */
/* Acceptance rate limiting (same sliding-window shape as public       */
/* quotation protection; fails open on any internal error).            */
/* ------------------------------------------------------------------ */

export const INVITE_ACCEPT_LIMIT = 10;
export const INVITE_ACCEPT_WINDOW_MS = 60 * 60_000;

const buckets = new Map<string, number[]>();

export function resetInviteAcceptRateLimit(): void {
  buckets.clear();
}

export function checkInviteAcceptRate(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; remaining: number } {
  try {
    if (!key) return { allowed: true, remaining: INVITE_ACCEPT_LIMIT };
    const cutoff = now - INVITE_ACCEPT_WINDOW_MS;
    const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= INVITE_ACCEPT_LIMIT) {
      buckets.set(key, hits);
      return { allowed: false, remaining: 0 };
    }
    hits.push(now);
    buckets.set(key, hits);
    if (buckets.size > 5_000) {
      const first = buckets.keys().next();
      if (!first.done && first.value !== key) buckets.delete(first.value);
    }
    return { allowed: true, remaining: INVITE_ACCEPT_LIMIT - hits.length };
  } catch {
    return { allowed: true, remaining: INVITE_ACCEPT_LIMIT };
  }
}

/* ------------------------------------------------------------------ */
/* Shaping                                                             */
/* ------------------------------------------------------------------ */

export type TeamMemberRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  last_seen_at: string | null;
};

export type TeamRoleRow = { user_id: string; role: string };

export type TeamMember = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  roleLabel: string;
  lastSeenAt: string | null;
};

export function buildTeamMembers(
  profiles: TeamMemberRow[],
  roles: TeamRoleRow[],
): TeamMember[] {
  const roleByUser = new Map<string, string>();
  for (const r of roles) {
    const current = roleByUser.get(r.user_id);
    // owner outranks everything else when a user somehow holds several rows.
    if (!current || r.role === "owner") roleByUser.set(r.user_id, r.role);
  }
  return profiles
    .map((p) => {
      const role = roleByUser.get(p.id) ?? "agent";
      return {
        id: p.id,
        name: p.full_name?.trim() || p.email || "Member",
        email: p.email,
        role,
        roleLabel: roleLabel(role),
        lastSeenAt: p.last_seen_at,
      };
    })
    .sort((a, b) => {
      const rank = (r: string) => (r === "owner" ? 0 : r === "admin" ? 1 : 2);
      return rank(a.role) - rank(b.role) || a.name.localeCompare(b.name);
    });
}

export type InvitationRow = {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
};

export type TeamInvitation = InvitationRow & {
  roleLabel: string;
  isExpired: boolean;
  displayStatus: "pending" | "accepted" | "revoked" | "expired";
};

export function shapeInvitations(
  rows: InvitationRow[],
  now: number = Date.now(),
): TeamInvitation[] {
  return rows.map((row) => {
    const isExpired = new Date(row.expires_at).getTime() <= now;
    const displayStatus =
      row.status === "pending" && isExpired
        ? "expired"
        : (row.status as "pending" | "accepted" | "revoked");
    return { ...row, roleLabel: roleLabel(row.role), isExpired, displayStatus };
  });
}
