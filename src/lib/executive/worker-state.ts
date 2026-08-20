/**
 * UMRAIO® — Specialist AI Workforce semantic state model.
 *
 * PRESENTATION-DERIVATION ONLY. Every state below is derived from real backend
 * records (`ai_workers` + `ai_tasks`). Nothing here fabricates execution.
 *
 * CRITICAL SEMANTIC RULE:
 *   Autonomy (autonomous / approval-required / paused) describes the worker's
 *   OPERATING MODE. Execution state (never run / executing / completed …)
 *   describes what has ACTUALLY happened. They are never merged.
 */
import { ACTIVE_STATUSES, type EngineTask } from "@/lib/tasks";
import type { AiWorker } from "@/lib/executive";

export type WorkerRuntimeState =
  | "ready"
  | "analysing"
  | "awaiting_approval"
  | "executing"
  | "monitoring"
  | "completed"
  | "failed"
  | "escalated"
  | "never_run"
  | "paused";

export type WorkerAutonomy = "autonomous" | "approval_required" | "paused";

export type WorkerRuntime = {
  state: WorkerRuntimeState;
  autonomy: WorkerAutonomy;
  /** The single task the worker is currently occupied with, if any. */
  activeTask: EngineTask | null;
  /** Most recent task that actually finished (completed or failed). */
  lastExecution: EngineTask | null;
  /** ISO timestamp of the last real execution, or null when never executed. */
  lastExecutionAt: string | null;
  counts: {
    running: number;
    queued: number;
    awaitingApproval: number;
    completed: number;
    failed: number;
  };
};

/** Tone classes per state — dark-navy system, restrained accents. */
export const RUNTIME_TONE: Record<WorkerRuntimeState, string> = {
  ready: "bg-primary/12 text-primary",
  analysing: "bg-primary/18 text-primary",
  awaiting_approval: "bg-gold/15 text-gold-bright",
  executing: "bg-emerald/15 text-emerald",
  monitoring: "bg-electric/15 text-electric",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  escalated: "bg-ruby/15 text-ruby-bright",
  never_run: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
};

export const AUTONOMY_TONE: Record<WorkerAutonomy, string> = {
  autonomous: "border-emerald/35 text-emerald",
  approval_required: "border-gold/40 text-gold-bright",
  paused: "border-border/60 text-muted-foreground",
};

const finished = (t: EngineTask) => t.status === "completed" || t.status === "failed";

/**
 * Derives the truthful runtime state of one specialist worker.
 * `tasks` may be the full engine task list — it is filtered here.
 */
export function deriveWorkerRuntime(worker: AiWorker, allTasks: EngineTask[]): WorkerRuntime {
  const tasks = allTasks.filter((t) => t.worker_key === worker.worker_key);

  const running = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const queued = tasks.filter((t) => t.status === "queued");
  const awaiting = tasks.filter((t) => t.status === "waiting_approval");
  const completed = tasks.filter((t) => t.status === "completed");
  const failedTasks = tasks.filter((t) => t.status === "failed");

  const executions = tasks
    .filter(finished)
    .sort(
      (a, b) =>
        new Date(b.completed_at ?? b.created_at).getTime() -
        new Date(a.completed_at ?? a.created_at).getTime(),
    );
  const lastExecution = executions[0] ?? null;
  const lastExecutionAt = lastExecution?.completed_at ?? worker.last_run_at ?? null;

  const autonomy: WorkerAutonomy = !worker.is_enabled
    ? "paused"
    : worker.autonomy === "auto"
      ? "autonomous"
      : "approval_required";

  // Escalation: an approval-gated action that failed needs a human, not a retry.
  const escalated = failedTasks.find((t) => t.requires_approval) ?? null;

  const executing = running.find((t) => t.kind === "executive_action") ?? null;
  const analysing = running[0] ?? null;

  let state: WorkerRuntimeState;
  let activeTask: EngineTask | null = null;

  if (!worker.is_enabled) {
    state = "paused";
  } else if (escalated) {
    state = "escalated";
    activeTask = escalated;
  } else if (executing) {
    state = "executing";
    activeTask = executing;
  } else if (analysing) {
    state = "analysing";
    activeTask = analysing;
  } else if (awaiting.length > 0) {
    state = "awaiting_approval";
    activeTask = awaiting[0] ?? null;
  } else if (queued.length > 0) {
    state = "ready";
    activeTask = queued[0] ?? null;
  } else if (!lastExecutionAt && completed.length === 0 && failedTasks.length === 0) {
    state = "never_run";
  } else if (lastExecution?.status === "failed") {
    state = "failed";
  } else if (
    lastExecutionAt &&
    Date.now() - new Date(lastExecutionAt).getTime() < 6 * 60 * 60 * 1000
  ) {
    // Recently executed work is still being watched for a business outcome.
    state = lastExecution?.kind === "executive_action" ? "monitoring" : "completed";
  } else {
    state = "ready";
  }

  return {
    state,
    autonomy,
    activeTask,
    lastExecution,
    lastExecutionAt,
    counts: {
      running: running.length,
      queued: queued.length,
      awaitingApproval: awaiting.length,
      completed: completed.length,
      failed: failedTasks.length,
    },
  };
}

/** Stable display order of the Specialist AI Workforce. */
export const WORKFORCE_ORDER = [
  "sales_elite",
  "whatsapp",
  "marketing",
  "lead_intel",
  "content",
] as const;

export function sortWorkforce<T extends { worker_key: string }>(workers: T[]): T[] {
  const rank = (key: string) => {
    const i = (WORKFORCE_ORDER as readonly string[]).indexOf(key);
    return i === -1 ? WORKFORCE_ORDER.length : i;
  };
  return [...workers].sort((a, b) => rank(a.worker_key) - rank(b.worker_key));
}
