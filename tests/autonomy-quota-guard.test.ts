import { describe, expect, it } from "vitest";

import { observeAndQueue } from "../src/lib/task-engine.server";

/**
 * QUOTA STORM GUARD — observeAndQueue must not create autonomous ai_tasks
 * for an agency whose ai_tasks allowance is exhausted (checkQuota gate),
 * while an agency with remaining allowance still gets tasks queued.
 */

type MockOptions = { taskUsageCount: number };

function makeSupabase(opts: MockOptions) {
  const state = { taskInserts: 0, notifications: 0 };

  const usageCountQuery = {
    eq: () => usageCountQuery,
    gte: () => Promise.resolve({ count: opts.taskUsageCount, error: null }),
  };

  const entitlementsQuery = {
    eq: () => entitlementsQuery,
    maybeSingle: () => Promise.resolve({ data: null, error: null }), // trial default
  };

  const leadsQuery = {
    eq: () => leadsQuery,
    limit: () =>
      Promise.resolve({
        data: [
          {
            id: "lead-1",
            full_name: "Test Lead",
            stage: "new",
            temperature: "cold",
            score: 10,
            last_contact_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        error: null,
      }),
  };

  const aiTasksSelect = {
    eq: () => aiTasksSelect,
    order: () => aiTasksSelect,
    limit: () => aiTasksSelect,
    maybeSingle: () => Promise.resolve({ data: null, error: null }), // never run before
  };

  const aiTasksInsert = {
    insert: () => {
      state.taskInserts += 1;
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: "task-1" }, error: null }),
        }),
      };
    },
    select: () => aiTasksSelect,
  };

  const notifications = {
    insert: () => {
      state.notifications += 1;
      return Promise.resolve({ error: null });
    },
    select: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  };

  const supabase = {
    from(table: string) {
      if (table === "usage_events") return { select: () => usageCountQuery };
      if (table === "agency_entitlements") return { select: () => entitlementsQuery };
      if (table === "leads") return { select: () => leadsQuery };
      if (table === "ai_tasks") return aiTasksInsert;
      if (table === "notifications") return notifications;
      throw new Error(`unexpected table: ${table}`);
    },
  };

  return { supabase: supabase as never, state };
}

describe("observeAndQueue autonomy quota guard", () => {
  it("skips all autonomous task creation when the ai_tasks allowance is exhausted", async () => {
    // trial plan limit is 60 ai_tasks/month; 61 used => exhausted
    const { supabase, state } = makeSupabase({ taskUsageCount: 61 });
    const queued = await observeAndQueue(supabase, "agency-exhausted");
    expect(queued).toEqual([]);
    expect(state.taskInserts).toBe(0);
    expect(state.notifications).toBe(0);
  });

  it("still queues autonomous tasks for an agency with remaining allowance", async () => {
    const { supabase, state } = makeSupabase({ taskUsageCount: 0 });
    const queued = await observeAndQueue(supabase, "agency-allowed");
    expect(queued.length).toBeGreaterThan(0);
    expect(state.taskInserts).toBeGreaterThan(0);
  });
});
