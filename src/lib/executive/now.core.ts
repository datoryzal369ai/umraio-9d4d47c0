/**
 * UMRAIO® — EXECUTIVE NOW selection (pure derivation).
 *
 * "What does the AI AUTONOMOUS BUSINESS EXECUTIVE™ want the Agency Owner to
 * know or decide right now?" — answered only from real persisted task state.
 * Nothing here fabricates priority, confidence, targets or outcomes.
 */
import type { Lead } from "@/lib/leads";
import type { EngineTask } from "@/lib/tasks";
import type { OutcomeFinding } from "@/lib/executive/outcome.core";
import { WORKER_LABELS } from "@/lib/worker-labels";

export type NowPriority = "HIGH" | "MEDIUM" | "LOW";

export type NowApproval = "required" | "not_required" | "approved" | "rejected";

export type NowState =
  | "waiting_approval"
  | "executing"
  | "monitoring"
  | "completed"
  | "failed"
  | "escalated";

export type ExecutiveNow = {
  task: EngineTask;
  priority: NowPriority;
  objective: string;
  target: string | null;
  targetLeadId: string | null;
  worker: string;
  reason: string | null;
  /** Percent, only when the decision actually recorded one. */
  confidence: number | null;
  expectedOutcome: string | null;
  approval: NowApproval;
  state: NowState;
  finding: OutcomeFinding | null;
  canApprove: boolean;
};

export const NOW_STATE_LABEL: Record<NowState, string> = {
  waiting_approval: "WAITING APPROVAL",
  executing: "EXECUTING",
  monitoring: "MONITORING",
  completed: "COMPLETED",
  failed: "FAILED",
  escalated: "ESCALATED",
};

export const NOW_STATE_TONE: Record<NowState, string> = {
  waiting_approval: "bg-gold/15 text-gold-bright",
  executing: "bg-emerald/15 text-emerald",
  monitoring: "bg-electric/15 text-electric",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  escalated: "bg-ruby/15 text-ruby-bright",
};

export const NOW_APPROVAL_LABEL: Record<NowApproval, string> = {
  required: "REQUIRED",
  not_required: "NOT REQUIRED",
  approved: "APPROVED",
  rejected: "REJECTED",
};

export const NOW_PRIORITY_TONE: Record<NowPriority, string> = {
  HIGH: "bg-ruby/15 text-ruby-bright",
  MEDIUM: "bg-gold/15 text-gold-bright",
  LOW: "bg-muted text-muted-foreground",
};

function priorityOf(task: EngineTask): NowPriority {
  if (task.priority === "critical" || task.priority === "high") return "HIGH";
  if (task.priority === "low") return "LOW";
  return "MEDIUM";
}

/** Ranks candidate actions by how urgently a human should look at them. */
function rank(task: EngineTask): number {
  if (task.status === "failed" && task.requires_approval) return 0; // escalated
  if (task.status === "waiting_approval") return 1;
  if (["running", "processing", "analysing", "planning"].includes(task.status)) return 2;
  if (task.status === "failed") return 3;
  if (task.status === "completed") return 4;
  return 9;
}

export function selectExecutiveNow(input: {
  tasks: EngineTask[];
  leads: Lead[];
  findings: OutcomeFinding[];
}): ExecutiveNow | null {
  const { tasks, leads, findings } = input;

  const candidates = tasks.filter((t) => rank(t) < 9);
  if (candidates.length === 0) return null;

  const openFinding = (taskId: string) =>
    findings.find((f) => f.taskId === taskId && f.outcome !== "unknown") ?? null;

  const sorted = [...candidates].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    // Completed actions only matter while their outcome is still worth reading.
    const pa = priorityOf(a) === "HIGH" ? 0 : priorityOf(a) === "MEDIUM" ? 1 : 2;
    const pb = priorityOf(b) === "HIGH" ? 0 : priorityOf(b) === "MEDIUM" ? 1 : 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const task = sorted[0];
  if (!task) return null;

  // A completed action is only "now" business while its outcome is unresolved
  // or it has not yet been observed. A progressed outcome is not a to-do.
  const finding = openFinding(task.id);
  if (task.status === "completed" && finding && finding.outcome === "progressed") return null;

  const lead = task.lead_id ? leads.find((l) => l.id === task.lead_id) ?? null : null;

  const approval: NowApproval = !task.requires_approval
    ? "not_required"
    : task.status === "waiting_approval"
      ? "required"
      : task.status === "rejected"
        ? "rejected"
        : "approved";

  const state: NowState =
    task.status === "failed" && task.requires_approval
      ? "escalated"
      : task.status === "failed"
        ? "failed"
        : task.status === "waiting_approval"
          ? "waiting_approval"
          : task.status === "completed"
            ? finding && finding.outcome !== "unknown"
              ? "completed"
              : "monitoring"
            : "executing";

  const confidenceRaw = task.input?.decision_confidence;
  const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
    ? Math.round(confidenceRaw)
    : null;

  return {
    task,
    priority: priorityOf(task),
    objective: task.input?.objective ?? task.title,
    target: lead
      ? `${lead.full_name} (#${lead.id.slice(0, 8).toUpperCase()})`
      : task.lead_id
        ? `Lead #${task.lead_id.slice(0, 8).toUpperCase()}`
        : null,
    targetLeadId: task.lead_id,
    worker: task.input?.worker ?? WORKER_LABELS[task.worker_key] ?? task.worker_key,
    reason: task.input?.reason ?? task.approval_reason ?? null,
    confidence,
    expectedOutcome: task.input?.expected_outcome ?? null,
    approval,
    state,
    finding,
    canApprove: task.status === "waiting_approval",
  };
}
