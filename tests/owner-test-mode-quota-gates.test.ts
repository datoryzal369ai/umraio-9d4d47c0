import { beforeEach, describe, expect, it, vi } from "vitest";

const overrideCalls: Array<{ agencyId: string; category: string }> = [];
let activeOverride: { agencyId: string; categories: string[] } | null = null;

vi.mock("@/lib/testing/owner-test-mode.server", () => ({
  isQuotaOverrideActive: async (_db: unknown, agencyId: string, category: string) => {
    overrideCalls.push({ agencyId, category });
    return activeOverride?.agencyId === agencyId && activeOverride.categories.includes(category);
  },
  readOwnerTestOverride: async () => ({
    enabled: false,
    categories: [],
    reason: null,
    enabledAt: null,
    expiresAt: null,
    enabledBy: null,
  }),
}));

vi.mock("../src/lib/billing/entitlements.server", () => ({
  resolveEntitlement: async () => ({
    plan: {
      code: "growth",
      label: "Growth",
      aiRepliesPerMonth: 300,
      aiTasksPerMonth: 60,
      voiceMinutesPerMonth: 15,
    },
  }),
}));

/** Truthful counters for the live test agency: 205/300, 66/60, 15/15. */
const COUNTS = { ai_replies: 205, ai_tasks: 66, voice_seconds: 15 * 60 };
const writes: unknown[] = [];

function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, string> = {};
      const builder: Record<string, unknown> = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.head) {
            return {
              eq(col: string, value: string) {
                filters[col] = value;
                return this;
              },
              gte() {
                const bucket = filters["counts_against"];
                return Promise.resolve({
                  count: bucket === "ai_replies" ? COUNTS.ai_replies : COUNTS.ai_tasks,
                  error: null,
                });
              },
            };
          }
          return {
            eq(col: string, value: string) {
              filters[col] = value;
              return this;
            },
            gte() {
              return this;
            },
            limit() {
              return Promise.resolve({
                data: [{ duration_seconds: COUNTS.voice_seconds }],
                error: null,
              });
            },
          };
        },
        upsert(row: unknown) {
          writes.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
      return builder as never;
    },
  } as never;
}

const AGENCY = "efaa961f-4f40-441c-8acd-53cd13061723";

describe("quota gates with Owner Test Mode", () => {
  beforeEach(() => {
    overrideCalls.length = 0;
    writes.length = 0;
    activeOverride = null;
  });

  it("enforces normally when test mode is OFF", async () => {
    const usage = await import("@/lib/billing/usage.server");
    await expect(usage.assertQuota(makeDb(), AGENCY, "customer_reply")).rejects.toThrow(
      usage.QuotaError,
    );
    await expect(usage.assertQuota(makeDb(), AGENCY, "ai_task")).rejects.toThrow(usage.QuotaError);
    await expect(usage.assertVoiceQuota(makeDb(), AGENCY, 20)).rejects.toThrow(usage.QuotaError);
  });

  it("bypasses only the categories the owner enabled", async () => {
    const usage = await import("@/lib/billing/usage.server");
    activeOverride = { agencyId: AGENCY, categories: ["ai_replies"] };

    const replies = await usage.assertQuota(makeDb(), AGENCY, "customer_reply");
    expect(replies.allowed).toBe(true);
    expect(replies.overridden).toBe(true);

    await expect(usage.assertQuota(makeDb(), AGENCY, "ai_task")).rejects.toThrow(usage.QuotaError);
  });

  it("bypasses AI worker tasks past the real limit without changing it", async () => {
    const usage = await import("@/lib/billing/usage.server");
    activeOverride = { agencyId: AGENCY, categories: ["ai_tasks"] };
    const tasks = await usage.assertQuota(makeDb(), AGENCY, "ai_task");
    expect(tasks.overridden).toBe(true);
    expect(tasks.used).toBe(66);
    expect(tasks.limit).toBe(60); // real plan limit untouched
  });

  it("lets the voice pipeline proceed past 15/15 with truthful counters", async () => {
    const usage = await import("@/lib/billing/usage.server");
    activeOverride = { agencyId: AGENCY, categories: ["voice_minutes"] };
    const voice = await usage.assertVoiceQuota(makeDb(), AGENCY, 30);
    expect(voice.overridden).toBe(true);
    expect(voice.used).toBe(15);
    expect(voice.limit).toBe(15);
    expect(voice.remaining).toBe(0);
  });

  it("never writes usage, plan or billing state while bypassing", async () => {
    const usage = await import("@/lib/billing/usage.server");
    activeOverride = { agencyId: AGENCY, categories: ["ai_replies", "ai_tasks", "voice_minutes"] };
    await usage.assertQuota(makeDb(), AGENCY, "customer_reply");
    await usage.assertVoiceQuota(makeDb(), AGENCY, 30);
    expect(writes).toEqual([]);
  });

  it("is isolated per agency", async () => {
    const usage = await import("@/lib/billing/usage.server");
    activeOverride = { agencyId: "other-agency", categories: ["ai_replies"] };
    await expect(usage.assertQuota(makeDb(), AGENCY, "customer_reply")).rejects.toThrow(
      usage.QuotaError,
    );
  });

  it("restores enforcement when test mode is turned off", async () => {
    const usage = await import("@/lib/billing/usage.server");
    activeOverride = { agencyId: AGENCY, categories: ["ai_replies"] };
    await usage.assertQuota(makeDb(), AGENCY, "customer_reply");
    activeOverride = null;
    await expect(usage.assertQuota(makeDb(), AGENCY, "customer_reply")).rejects.toThrow(
      usage.QuotaError,
    );
  });
});
