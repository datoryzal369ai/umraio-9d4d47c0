import { describe, expect, it } from "vitest";

import {
  buildAgencySummaries,
  buildAgencyUsers,
  buildPlatformStats,
  isUuid,
  lastActivityByAgency,
  maskSessionKey,
  sortRoles,
  HQ_SECURITY_CHECKS,
} from "@/lib/hq/hq.core";

const agencies = [
  { id: "a1", name: "Alpha Travel", plan: "trial", created_at: "2026-01-01T00:00:00Z" },
  { id: "a2", name: "Beta Umrah", plan: "basic", created_at: "2026-02-01T00:00:00Z" },
];

const profiles = [
  { id: "u1", agency_id: "a1", full_name: "Owner One", email: "o1@x.com", last_seen_at: "2026-08-31T10:00:00Z" },
  { id: "u2", agency_id: "a1", full_name: "Agent Two", email: "a2@x.com", last_seen_at: null },
  { id: "u3", agency_id: "a2", full_name: "Owner Three", email: "o3@x.com", last_seen_at: null },
];

const roles = [
  { user_id: "u1", agency_id: "a1", role: "owner" },
  { user_id: "u2", agency_id: "a1", role: "agent" },
  { user_id: "u3", agency_id: "a2", role: "owner" },
];

describe("HQ agency summaries", () => {
  it("counts users and resolves the owner per agency", () => {
    const rows = buildAgencySummaries(agencies, profiles, roles);
    const alpha = rows.find((r) => r.id === "a1")!;
    expect(alpha.userCount).toBe(2);
    expect(alpha.ownerName).toBe("Owner One");
    expect(rows.find((r) => r.id === "a2")!.userCount).toBe(1);
  });

  it("prefers the entitlement effective plan when present", () => {
    const rows = buildAgencySummaries(agencies, profiles, roles, [
      { agency_id: "a1", effective_plan: "premium", source: "override" },
    ]);
    expect(rows.find((r) => r.id === "a1")!.plan).toBe("premium");
    expect(rows.find((r) => r.id === "a2")!.plan).toBe("basic");
  });
});

describe("HQ agency users", () => {
  it("attaches roles and presence", () => {
    const users = buildAgencyUsers(
      profiles.filter((p) => p.agency_id === "a1"),
      roles.filter((r) => r.agency_id === "a1"),
    );
    expect(users.map((u) => u.name)).toEqual(["Agent Two", "Owner One"]);
    expect(users.find((u) => u.id === "u1")!.roles).toEqual(["owner"]);
    expect(users.find((u) => u.id === "u2")!.lastSeenAt).toBeNull();
  });

  it("orders multiple roles by privilege", () => {
    expect(sortRoles(["agent", "platform_owner", "owner"])).toEqual([
      "platform_owner",
      "owner",
      "agent",
    ]);
  });
});

describe("HQ agency selector validation", () => {
  it("rejects anything that is not a uuid", () => {
    expect(isUuid("a1")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid("11111111-2222-3333-4444-555555555555")).toBe(true);
  });
});

describe("Founder HQ control center", () => {
  it("masks session keys and never reveals the full value", () => {
    expect(maskSessionKey(null)).toBe("—");
    expect(maskSessionKey("abc")).toBe("••••");
    const masked = maskSessionKey("session-key-1234567890");
    expect(masked).toBe("sess••••90");
    expect(masked).not.toContain("session-key-1234567890");
  });

  it("derives platform stats from existing rows only", () => {
    const now = Date.parse("2026-09-01T00:00:00Z");
    const recent = new Date(now - 2 * 24 * 3600 * 1000).toISOString();
    const summaries = buildAgencySummaries(agencies, profiles, roles);
    const stats = buildPlatformStats(
      summaries,
      [{ ...profiles[0]!, last_seen_at: recent }, profiles[1]!, profiles[2]!],
      [
        {
          id: "e1",
          user_id: "u1",
          agency_id: "a1",
          event_type: "login",
          session_key: "k",
          occurred_at: recent,
        },
      ],
      now,
    );
    expect(stats.totalAgencies).toBe(2);
    expect(stats.totalUsers).toBe(3);
    expect(stats.trialAgencies).toBe(1);
    expect(stats.activeSubscriptions).toBe(1);
    expect(stats.activeAgencies).toBe(1);
    expect(stats.recentlyActiveUsers).toBe(1);
    expect(stats.recentLogins).toBe(1);
  });

  it("resolves last activity per agency", () => {
    const map = lastActivityByAgency(profiles, [
      {
        id: "e1",
        user_id: "u3",
        agency_id: "a2",
        event_type: "login",
        session_key: null,
        occurred_at: "2026-08-30T00:00:00Z",
      },
    ]);
    expect(map["a1"]).toBe("2026-08-31T10:00:00Z");
    expect(map["a2"]).toBe("2026-08-30T00:00:00Z");
  });

  it("exposes only audited, non-secret security checks", () => {
    expect(HQ_SECURITY_CHECKS.length).toBeGreaterThan(0);
    for (const c of HQ_SECURITY_CHECKS) {
      expect(c.status).toBe("audited");
      expect(JSON.stringify(c)).not.toMatch(/key=|secret|token=/i);
    }
  });
});
