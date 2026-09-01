/**
 * UMRAIO® — Agency Team / Invitation V1.
 *
 * The security boundary is the SQL: SECURITY DEFINER functions re-derive the
 * caller's agency and role. These tests assert the client-side contract plus
 * the invariants of the shipped migration source, so a regression that
 * loosens either surface fails here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INVITABLE_ROLES,
  INVITATION_INVALID_MESSAGE,
  buildTeamMembers,
  canManageInvitations,
  canManageMembers,
  canSeeNavItem,
  canSeeTeam,
  effectiveAgencyRole,
  homeRouteForRoles,
  isInvitableRole,
  isPlatformOwner,
  invitationExpiry,
  shapeInvitations,
} from "@/lib/team/team.core";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const inviteSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .filter((sql) => sql.includes("public.accept_agency_invitation"))
  .join("\n");

const HOUR = 3_600_000;
const now = Date.UTC(2026, 8, 1);

function invitation(overrides: Partial<Parameters<typeof shapeInvitations>[0][number]> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "staff@agency.com",
    role: "agent",
    status: "pending",
    expires_at: new Date(now + 24 * HOUR).toISOString(),
    created_at: new Date(now - HOUR).toISOString(),
    accepted_at: null,
    ...overrides,
  };
}

describe("invitation lifecycle states", () => {
  it("shows a valid pending invitation", () => {
    expect(shapeInvitations([invitation()], now)[0]!.displayStatus).toBe("pending");
  });

  it("marks an expired invitation", () => {
    const row = invitation({ expires_at: new Date(now - HOUR).toISOString() });
    const shaped = shapeInvitations([row], now)[0]!;
    expect(shaped.displayStatus).toBe("expired");
    expect(shaped.isExpired).toBe(true);
  });

  it("marks an already accepted invitation", () => {
    const row = invitation({ status: "accepted", accepted_at: new Date(now).toISOString() });
    expect(shapeInvitations([row], now)[0]!.displayStatus).toBe("accepted");
  });

  it("issues expiry inside the database-accepted window", () => {
    const ms = new Date(invitationExpiry(now)).getTime() - now;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(30 * 24 * HOUR);
  });

  it("returns one generic message for every failure mode", () => {
    expect(INVITATION_INVALID_MESSAGE).not.toMatch(/expired|used|email|token hash/i);
  });
});

describe("invitable roles", () => {
  it("permits admin, agent and islamic_approver", () => {
    expect([...INVITABLE_ROLES]).toEqual(["admin", "agent", "islamic_approver"]);
    for (const role of INVITABLE_ROLES) expect(isInvitableRole(role)).toBe(true);
  });

  it("rejects owner and platform_owner", () => {
    expect(isInvitableRole("owner")).toBe(false);
    expect(isInvitableRole("platform_owner")).toBe(false);
  });

  it("mirrors the role allow-list in SQL", () => {
    expect(inviteSql).toContain("role IN ('admin','agent','islamic_approver')");
    expect(inviteSql).toContain("RAISE EXCEPTION 'role not invitable'");
  });
});

describe("management permissions (UI mirror of SQL rules)", () => {
  it("owner and admin may create and revoke invitations", () => {
    expect(canManageInvitations("owner")).toBe(true);
    expect(canManageInvitations("admin")).toBe(true);
  });

  it("agent and islamic_approver may not create invitations", () => {
    expect(canManageInvitations("agent")).toBe(false);
    expect(canManageInvitations("islamic_approver")).toBe(false);
    expect(canManageInvitations(null)).toBe(false);
  });

  it("only the owner may change roles or remove members", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(false);
    expect(canManageMembers("agent")).toBe(false);
  });

  it("SQL enforces manager-only creation and revocation", () => {
    expect(inviteSql).toContain("private.is_agency_manager");
    expect(inviteSql).toContain("RAISE EXCEPTION 'forbidden'");
  });
});

describe("acceptance is database-authoritative", () => {
  it("matches the invited email against the verified JWT email", () => {
    expect(inviteSql).toContain("auth.jwt() ->> 'email'");
    expect(inviteSql).toContain("lower(v_inv.email) <> v_email");
  });

  it("is single-use: only a pending row transitions to accepted", () => {
    expect(inviteSql).toContain("SET status = 'accepted'");
    expect(inviteSql).toContain("WHERE id = v_inv.id AND status = 'pending'");
  });

  it("rejects expired tokens", () => {
    expect(inviteSql).toContain("v_inv.expires_at <= now()");
  });

  it("attaches the member to the invitation's agency, never a client value", () => {
    expect(inviteSql).toContain("UPDATE public.profiles SET agency_id = v_inv.agency_id");
    expect(inviteSql).toContain("VALUES (v_uid, v_inv.agency_id, v_inv.role)");
    // no parameter other than the token hash is accepted
    expect(inviteSql).toContain("accept_agency_invitation(p_token_hash text)");
  });

  it("keeps a cross-agency token useless without the matching invited email", () => {
    // agency is read from the invitation row, and the row is only reachable
    // by exact token hash plus matching JWT email.
    expect(inviteSql).toContain("WHERE token_hash = p_token_hash");
  });

  it("never re-tenants the founder platform owner", () => {
    expect(inviteSql).toContain("private.is_platform_owner(v_uid)");
  });

  it("keeps tenant immutability enforced outside the audited functions", () => {
    expect(inviteSql).toContain("umraio.allow_tenant_move");
    expect(inviteSql).toContain("agency_id cannot be modified");
  });
});

describe("role-aware navigation", () => {
  it("treats platform_owner as a platform capability, not an agency role", () => {
    expect(effectiveAgencyRole(["platform_owner", "owner"])).toBe("owner");
    expect(isPlatformOwner(["platform_owner", "owner"])).toBe(true);
    expect(homeRouteForRoles(["platform_owner", "owner"])).toBe("/hq");
  });

  it("routes normal agency roles to the workspace", () => {
    expect(homeRouteForRoles(["owner"])).toBe("/dashboard");
    expect(homeRouteForRoles(["agent"])).toBe("/dashboard");
  });

  it("hides management surfaces from agents", () => {
    expect(canSeeNavItem("agent", "/leads")).toBe(true);
    expect(canSeeNavItem("agent", "/conversations")).toBe(true);
    expect(canSeeNavItem("agent", "/settings/agency")).toBe(false);
    expect(canSeeTeam("agent")).toBe(false);
  });

  it("keeps team management with owner and admin", () => {
    expect(canSeeTeam("owner")).toBe(true);
    expect(canSeeTeam("admin")).toBe(true);
    expect(canSeeTeam("islamic_approver")).toBe(false);
  });

  it("preserves the Islamic approver governance surface", () => {
    expect(canSeeNavItem("islamic_approver", "/settings/governance")).toBe(true);
    expect(canSeeNavItem("islamic_approver", "/settings/subscription")).toBe(false);
  });
});

describe("member shaping", () => {
  it("ranks the owner first and labels roles", () => {
    const members = buildTeamMembers(
      [
        { id: "u2", full_name: "Zara Agent", email: "z@x.com", last_seen_at: null },
        { id: "u1", full_name: "Ahmad Owner", email: "a@x.com", last_seen_at: null },
      ],
      [
        { user_id: "u1", role: "owner" },
        { user_id: "u2", role: "agent" },
      ],
    );
    expect(members.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(members[0]!.roleLabel).toBe("Owner");
  });
});
