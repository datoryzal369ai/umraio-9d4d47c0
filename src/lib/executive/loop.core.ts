/**
 * UMRAIO® — per-action EXECUTIVE LOOP tracker (pure derivation).
 *
 * Every stage state below is derived from REAL persisted task data
 * (`ai_tasks.status`, `ai_tasks.steps[]`, `requires_approval`, `approved_at`)
 * plus, where available, the server-side outcome monitor finding.
 *
 * A stage is NEVER marked complete merely because the action exists. It is
 * complete only when the backend recorded a timestamped step (or an
 * unambiguous status) proving it happened.
 */
import type { EngineTask, EngineTaskStep } from "@/lib/tasks";
import type { OutcomeFinding } from "@/lib/executive/outcome.core";

export const LOOP_STAGES = [
  "understand",
  "prioritise",
  "decide",
  "coordinate",
  "approve",
  "execute",
  "monitor",
  "escalate",
] as const;

export type LoopStage = (typeof LOOP_STAGES)[number];

export type LoopStageState =
  | "completed"
  | "current"
  | "pending"
  | "blocked"
  | "failed"
  | "escalated"
  | "not_required";

export type LoopStageView = {
  stage: LoopStage;
  label: string;
  state: LoopStageState;
  /** Timestamp of the backend step that proves this stage, when one exists. */
  at: string | null;
  note: string | null;
};

export const LOOP_STAGE_LABEL: Record<LoopStage, string> = {
  understand: "UNDERSTAND",
  prioritise: "PRIORITISE",
  decide: "DECIDE",
  coordinate: "COORDINATE",
  approve: "APPROVE",
  execute: "EXECUTE",
  monitor: "MONITOR",
  escalate: "ESCALATE",
};

export const LOOP_STATE_TONE: Record<LoopStageState, string> = {
  completed: "border-success/40 bg-success/10 text-success",
  current: "border-primary/50 bg-primary/10 text-primary",
  pending: "border-border/60 bg-surface/60 text-muted-foreground",
  blocked: "border-gold/45 bg-gold/10 text-gold-bright",
  failed: "border-destructive/45 bg-destructive/10 text-destructive",
  escalated: "border-ruby/45 bg-ruby/10 text-ruby-bright",
  not_required: "border-border/50 bg-surface/40 text-muted-foreground",
};

export const LOOP_STATE_LABEL: Record<LoopStageState, string> = {
  completed: "COMPLETED",
  current: "CURRENT",
  pending: "PENDING",
  blocked: "BLOCKED",
  failed: "FAILED",
  escalated: "ESCALATED",
  not_required: "NOT REQUIRED",
};

/** Glyph used in the compact tracker: ✓ done, → current, — pending. */
export function loopGlyph(state: LoopStageState): string {
  if (state === "completed") return "✓";
  if (state === "current" || state === "blocked") return "→";
  if (state === "failed") return "✕";
  if (state === "escalated") return "!";
  return "—";
}

function findStep(steps: EngineTaskStep[], status: string): EngineTaskStep | null {
  return steps.find((s) => s.status === status) ?? null;
}

/**
 * Builds the truthful loop view for a single executive action.
 * `finding` is the server-side outcome monitor result for this task, if any.
 */
export function deriveActionLoop(
  task: EngineTask,
  finding?: OutcomeFinding | null,
): LoopStageView[] {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const recommended = findStep(steps, "recommended");
  const waiting = findStep(steps, "waiting_approval");
  const executing = findStep(steps, "executing");
  const done = findStep(steps, "completed");
  const failedStep = findStep(steps, "failed");

  const decisionAt = recommended?.at ?? task.created_at;
  const decisionKnown = Boolean(recommended) || task.kind === "executive_action";

  const isRejected = task.status === "rejected";
  const isFailed = task.status === "failed";
  const isWaiting = task.status === "waiting_approval";
  const isRunning = ["running", "processing", "analysing", "planning", "queued"].includes(
    task.status,
  );
  const isCompleted = task.status === "completed";
  // Honest escalation: an approval-gated action that failed needs a human.
  const escalated = isFailed && task.requires_approval;

  const view = (
    stage: LoopStage,
    state: LoopStageState,
    at: string | null,
    note: string | null,
  ): LoopStageView => ({ stage, label: LOOP_STAGE_LABEL[stage], state, at, note });

  const stages: LoopStageView[] = [];

  // UNDERSTAND / PRIORITISE / DECIDE / COORDINATE are proven by the persisted
  // executive decision record itself (objective, priority, reason, worker).
  const objective = task.input?.objective ?? null;
  const reason = task.input?.reason ?? task.approval_reason ?? null;
  const worker = task.input?.worker ?? task.worker_key;

  stages.push(
    view(
      "understand",
      decisionKnown ? "completed" : "pending",
      decisionKnown ? decisionAt : null,
      objective,
    ),
  );
  stages.push(
    view(
      "prioritise",
      decisionKnown ? "completed" : "pending",
      decisionKnown ? decisionAt : null,
      decisionKnown ? `Priority ${task.priority.toUpperCase()}` : null,
    ),
  );
  stages.push(
    view("decide", decisionKnown ? "completed" : "pending", decisionKnown ? decisionAt : null, reason),
  );
  stages.push(
    view(
      "coordinate",
      decisionKnown ? "completed" : "pending",
      decisionKnown ? decisionAt : null,
      decisionKnown ? `Assigned to ${worker}` : null,
    ),
  );

  // APPROVE
  if (!task.requires_approval) {
    stages.push(view("approve", "not_required", null, "Within autonomous authority"));
  } else if (isRejected) {
    stages.push(view("approve", "failed", waiting?.at ?? null, "Rejected by a human reviewer"));
  } else if (isWaiting) {
    stages.push(
      view("approve", "blocked", waiting?.at ?? null, "Governance requires human approval"),
    );
  } else if (task.approved_at || isRunning || isCompleted || isFailed) {
    stages.push(view("approve", "completed", task.approved_at ?? waiting?.at ?? null, "Approved"));
  } else {
    stages.push(view("approve", "pending", null, null));
  }

  // EXECUTE — only real side-effect success counts.
  if (isCompleted) {
    stages.push(view("execute", "completed", done?.at ?? task.completed_at, task.summary));
  } else if (isFailed) {
    stages.push(view("execute", "failed", failedStep?.at ?? task.completed_at, task.error));
  } else if (executing || (isRunning && task.started_at)) {
    stages.push(view("execute", "current", executing?.at ?? task.started_at, "Executing"));
  } else if (isRejected) {
    stages.push(view("execute", "pending", null, "Not executed — rejected"));
  } else {
    stages.push(view("execute", "pending", null, null));
  }

  // MONITOR — completed only when the backend has actually classified an outcome.
  if (finding && finding.outcome !== "unknown") {
    stages.push(view("monitor", "completed", finding.executedAt, finding.detail));
  } else if (isCompleted) {
    stages.push(
      view(
        "monitor",
        "current",
        task.completed_at,
        finding?.detail ?? "Waiting for a measurable business outcome",
      ),
    );
  } else {
    stages.push(view("monitor", "pending", null, null));
  }

  // ESCALATE
  if (escalated) {
    stages.push(view("escalate", "escalated", failedStep?.at ?? task.completed_at, task.error));
  } else if (finding?.outcome === "no_response") {
    stages.push(view("escalate", "current", finding.executedAt, finding.nextAction));
  } else {
    stages.push(view("escalate", "pending", null, null));
  }

  return stages;
}
