import { describe, expect, it } from "vitest";

import { deriveActionLoop } from "@/lib/executive/loop.core";
import { selectExecutiveNow } from "@/lib/executive/now.core";
import { buildExecutiveInsights } from "@/lib/executive/evidence.core";
import type { EngineTask } from "@/lib/tasks";
import type { Lead } from "@/lib/leads";
import type { OutcomeFinding } from "@/lib/executive/outcome.core";

const now = new Date().toISOString();

function task(overrides: Partial<EngineTask> = {}): EngineTask {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    worker_key: "sales_elite",
    title: "Closing push: Ahmad",
    kind: "executive_action",
    status: "waiting_approval",
    priority: "high",
    origin: "autonomous",
    summary: null,
    error: null,
    plan: null,
    steps: [
      { at: now, status: "recommended", note: "Move Ahmad toward a booking decision" },
      { at: now, status: "waiting_approval", note: "High intent requires human approval" },
    ],
    output: null,
    minutes_saved: 15,
    requires_approval: true,
    approval_reason: "High intent requires human approval",
    lead_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    input: {
      objective: "Move Ahmad toward a booking decision",
      reason: "High intent, no reply in 24h",
      expected_outcome: "The lead receives a tailored recommendation",
      worker: "AI SALES ELITE™",
      decision_confidence: 75,
    },
    approved_at: null,
    created_at: now,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agency_id: "agency",
    full_name: "Ahmad",
    phone: null,
    email: null,
    source: "whatsapp",
    stage: "proposal" as Lead["stage"],
    temperature: "hot",
    tags: [],
    score: 82,
    budget_myr: null,
    pax: 2,
    preferred_month: "Ramadan 2027",
    preferred_language: "ms",
    detected_language: null,
    conversational_style: null,
    last_contact_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const stateOf = (t: EngineTask, stage: string, f?: OutcomeFinding | null) =>
  deriveActionLoop(t, f ?? null).find((s) => s.stage === stage)?.state;

describe("executive loop tracker", () => {
  it("blocks at APPROVE and leaves execution pending while awaiting approval", () => {
    const t = task();
    expect(stateOf(t, "decide")).toBe("completed");
    expect(stateOf(t, "approve")).toBe("blocked");
    expect(stateOf(t, "execute")).toBe("pending");
    expect(stateOf(t, "monitor")).toBe("pending");
  });

  it("marks APPROVE not required for autonomous actions", () => {
    expect(stateOf(task({ requires_approval: false }), "approve")).toBe("not_required");
  });

  it("only completes EXECUTE after a real completed side effect", () => {
    const completed = task({
      status: "completed",
      approved_at: now,
      completed_at: now,
      summary: "Follow-up scheduled",
      steps: [
        { at: now, status: "recommended", note: "x" },
        { at: now, status: "waiting_approval", note: "y" },
        { at: now, status: "executing", note: "z" },
        { at: now, status: "completed", note: "Follow-up scheduled" },
      ],
    });
    expect(stateOf(completed, "execute")).toBe("completed");
    // Action completion is not business success — monitoring is still open.
    expect(stateOf(completed, "monitor")).toBe("current");
  });

  it("keeps failure honest and escalates approval-gated failures", () => {
    const failed = task({ status: "failed", error: "insert failed", completed_at: now });
    expect(stateOf(failed, "execute")).toBe("failed");
    expect(stateOf(failed, "escalate")).toBe("escalated");
  });
});

describe("executive now", () => {
  it("selects the awaiting-approval action and allows approval only then", () => {
    const selected = selectExecutiveNow({ tasks: [task()], leads: [lead()], findings: [] });
    expect(selected?.state).toBe("waiting_approval");
    expect(selected?.canApprove).toBe(true);
    expect(selected?.approval).toBe("required");
    expect(selected?.confidence).toBe(75);
    expect(selected?.worker).toBe("AI SALES ELITE™");
  });

  it("never invents confidence when the decision recorded none", () => {
    const selected = selectExecutiveNow({
      tasks: [task({ input: { objective: "x" } })],
      leads: [lead()],
      findings: [],
    });
    expect(selected?.confidence).toBeNull();
  });

  it("shows a completed action as MONITORING until an outcome exists", () => {
    const t = task({ status: "completed", approved_at: now, completed_at: now });
    expect(selectExecutiveNow({ tasks: [t], leads: [lead()], findings: [] })?.state).toBe(
      "monitoring",
    );
  });

  it("returns nothing when no action requires attention", () => {
    expect(selectExecutiveNow({ tasks: [], leads: [lead()], findings: [] })).toBeNull();
  });
});

describe("executive insight evidence", () => {
  it("classifies fact, signal, interpretation and recommendation", () => {
    const insights = buildExecutiveInsights({ leads: [lead()], tasks: [task()], findings: [] });
    const pipeline = insights.find((i) => i.id.startsWith("pipeline"));
    expect(pipeline?.evidence.map((e) => e.kind)).toEqual([
      "fact",
      "signal",
      "interpretation",
      "recommendation",
    ]);
  });

  it("declares INSUFFICIENT DATA instead of inventing an assessment", () => {
    const insights = buildExecutiveInsights({ leads: [], tasks: [], findings: [] });
    const pipeline = insights.find((i) => i.id === "pipeline");
    expect(pipeline?.insufficient).not.toBeNull();
    expect(pipeline?.evidence).toHaveLength(0);
    expect(pipeline?.confidence).toBeNull();
  });
});
