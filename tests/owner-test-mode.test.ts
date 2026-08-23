import { describe, expect, it } from "vitest";

import {
  DISABLED_OVERRIDE_STATE,
  MAX_TEST_OVERRIDE_HOURS,
  TestOverrideValidationError,
  canManageTestOverride,
  describeOverride,
  isOverrideActive,
  normalizeCategories,
  validateEnableRequest,
  type OwnerTestOverrideState,
} from "@/lib/testing/owner-test-mode.core";
import {
  isQuotaOverrideActive,
  readOwnerTestOverride,
  resolveOwnerTestModeContext,
} from "@/lib/testing/owner-test-mode.server";

const NOW = new Date("2026-08-23T10:00:00.000Z");

function state(partial: Partial<OwnerTestOverrideState> = {}): OwnerTestOverrideState {
  return {
    enabled: true,
    categories: ["ai_replies", "ai_tasks", "voice_minutes"],
    reason: "E2E voice V2.1 test",
    enabledAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    enabledBy: "owner-1",
    ...partial,
  };
}

/** Minimal supabase stub: one table of override rows keyed by agency. */
function db(rows: Record<string, Record<string, unknown>>) {
  return {
    from() {
      let agency = "";
      const builder = {
        select: () => builder,
        eq: (_col: string, value: string) => {
          agency = value;
          return builder;
        },
        maybeSingle: async () => ({ data: rows[agency] ?? null, error: null }),
      };
      return builder;
    },
  } as never;
}

describe("owner test mode — authorization", () => {
  it("allows the agency owner", () => {
    expect(canManageTestOverride(["owner"])).toBe(true);
  });

  it("rejects non-owners (agent, admin, islamic_approver, none)", () => {
    expect(canManageTestOverride(["agent"])).toBe(false);
    expect(canManageTestOverride(["admin"])).toBe(false);
    expect(canManageTestOverride(["islamic_approver"])).toBe(false);
    expect(canManageTestOverride([])).toBe(false);
    expect(canManageTestOverride(null)).toBe(false);
  });

  it("resolves the authenticated profile agency and enum role row", async () => {
    const contextDb = {
      from(table: string) {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { agency_id: "agency-a" },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: async () => ({ data: [{ role: "owner" }], error: null }),
          }),
        };
      },
    } as never;

    await expect(resolveOwnerTestModeContext(contextDb, "owner-a")).resolves.toEqual({
      agencyId: "agency-a",
      roles: ["owner"],
    });
  });
});

describe("owner test mode — explicit confirmation and reason", () => {
  it("requires explicit confirmation", () => {
    expect(() =>
      validateEnableRequest({ reason: "voice testing now", categories: ["voice_minutes"] }, NOW),
    ).toThrow(TestOverrideValidationError);
  });

  it("requires a reason", () => {
    expect(() =>
      validateEnableRequest({ confirm: true, reason: "test", categories: ["voice_minutes"] }, NOW),
    ).toThrow(/reason/i);
  });

  it("requires at least one category", () => {
    expect(() =>
      validateEnableRequest({ confirm: true, reason: "voice testing now", categories: [] }, NOW),
    ).toThrow(/category/i);
  });

  it("accepts a valid request and clamps the duration", () => {
    const plan = validateEnableRequest(
      {
        confirm: true,
        reason: "E2E voice V2.1 test",
        categories: ["voice_minutes", "bogus", "ai_replies"],
        hours: 999,
      },
      NOW,
    );
    expect(plan.categories).toEqual(["ai_replies", "voice_minutes"]);
    expect(Date.parse(plan.expiresAt) - NOW.getTime()).toBe(MAX_TEST_OVERRIDE_HOURS * 3_600_000);
  });

  it("drops unknown categories", () => {
    expect(normalizeCategories(["ai_tasks", "billing", 3])).toEqual(["ai_tasks"]);
  });
});

describe("owner test mode — activation predicate", () => {
  it("is active only for selected categories", () => {
    const s = state({ categories: ["voice_minutes"] });
    expect(isOverrideActive(s, "voice_minutes", NOW)).toBe(true);
    expect(isOverrideActive(s, "ai_replies", NOW)).toBe(false);
    expect(isOverrideActive(s, "ai_tasks", NOW)).toBe(false);
  });

  it("is inactive when disabled (normal enforcement restored)", () => {
    expect(isOverrideActive(state({ enabled: false }), "ai_replies", NOW)).toBe(false);
    expect(isOverrideActive(DISABLED_OVERRIDE_STATE, "ai_replies", NOW)).toBe(false);
  });

  it("is inactive once expired", () => {
    const expired = state({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    expect(isOverrideActive(expired, "ai_replies", NOW)).toBe(false);
  });

  it("surfaces an obvious ON/OFF indicator", () => {
    expect(describeOverride(state(), NOW).on).toBe(true);
    expect(describeOverride(state(), NOW).label).toMatch(/ON/);
    expect(describeOverride(state({ enabled: false }), NOW).on).toBe(false);
  });
});

describe("owner test mode — agency scoping", () => {
  const rows = {
    "agency-a": {
      enabled: true,
      categories: ["ai_replies", "voice_minutes"],
      reason: "E2E test",
      enabled_at: NOW.toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      enabled_by: "owner-a",
    },
  };

  it("reads the override for the owning agency", async () => {
    const s = await readOwnerTestOverride(db(rows), "agency-a");
    expect(s.enabled).toBe(true);
    expect(s.categories).toEqual(["ai_replies", "voice_minutes"]);
  });

  it("has no cross-agency effect", async () => {
    expect(await isQuotaOverrideActive(db(rows), "agency-a", "ai_replies")).toBe(true);
    expect(await isQuotaOverrideActive(db(rows), "agency-b", "ai_replies")).toBe(false);
    expect(await isQuotaOverrideActive(db(rows), "agency-a", "ai_tasks")).toBe(false);
  });

  it("falls back to normal enforcement when the lookup fails", async () => {
    const broken = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              throw new Error("db down");
            },
          }),
        }),
      }),
    } as never;
    expect(await isQuotaOverrideActive(broken, "agency-a", "ai_replies")).toBe(false);
  });
});
