import { supabase } from "@/integrations/supabase/client";

import type { EngineTask, EngineTaskStep } from "@/lib/tasks";
import { WORKER_LABELS } from "@/lib/worker-labels";

/**
 * UMRAIO® — READ-ONLY executive audit read model.
 *
 * Reuses existing evidence records: `activity_log`, `executive_cycles` and
 * `ai_tasks.steps[]`. No second audit store is created, and the UI exposes no
 * way to edit or delete a historical event.
 */

export type AuditCategory =
  | "decision"
  | "approval"
  | "execution"
  | "failure"
  | "monitoring"
  | "escalation"
  | "other";

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  decision: "Decisions",
  approval: "Approvals",
  execution: "Executions",
  failure: "Failures",
  monitoring: "Monitoring",
  escalation: "Escalations",
  other: "Other",
};

/**
 * One intelligence colour family. Only failure/escalation keep a restrained
 * semantic tone for accessibility; everything else is turquoise at different
 * intensities.
 */
export const AUDIT_CATEGORY_TONE: Record<AuditCategory, string> = {
  decision: "border-primary/40 bg-primary/12 text-primary",
  approval: "border-primary/30 bg-primary/8 text-primary/90",
  execution: "border-primary/25 bg-primary/8 text-foreground/85",
  failure: "border-destructive/40 bg-destructive/10 text-destructive",
  monitoring: "border-border/70 bg-surface text-muted-foreground",
  escalation: "border-destructive/30 bg-destructive/8 text-destructive/90",
  other: "border-border/70 bg-surface text-muted-foreground",
};

export type AuditRow = {
  id: string;
  at: string;
  category: AuditCategory;
  /** Human-readable event name, e.g. "Executive decision". */
  event: string;
  entity: string | null;
  entityId: string | null;
  /** Who acted: the Master Executive, a specialist worker, or a human. */
  actor: string;
  action: string;
  state: string | null;
  result: string | null;
  approver: string | null;
  workerKey: string | null;
  leadId: string | null;
};

const MASTER = "AI AUTONOMOUS BUSINESS EXECUTIVE™";

function classifyActivity(action: string, meta: Record<string, unknown>): AuditCategory {
  const a = action.toLowerCase();
  if (a.includes("fail")) return "failure";
  if (a.includes("escalat")) return "escalation";
  if (a.includes("approved") || a.includes("rejected") || a.includes("approval")) return "approval";
  if (a.includes("executed") || a.includes("execution")) return "execution";
  if (a.includes("monitor") || a.includes("outcome")) return "monitoring";
  if (a.includes("decision") || a.includes("cycle") || meta["decisions"]) return "decision";
  return "other";
}

/** Maps a persisted task step to its audit category. */
function classifyStep(status: string): AuditCategory {
  if (status === "failed") return "failure";
  if (status === "completed") return "execution";
  if (status === "executing") return "execution";
  if (status === "waiting_approval") return "approval";
  if (status === "recommended") return "decision";
  return "other";
}

const STEP_EVENT: Record<string, string> = {
  recommended: "Executive decision",
  waiting_approval: "Approval requested",
  executing: "Execution started",
  completed: "Execution completed",
  failed: "Execution failed",
};

export async function fetchAuditRows(limit = 200): Promise<AuditRow[]> {
  const [activity, cycles, tasks] = await Promise.all([
    supabase
      .from("activity_log")
      .select("id, actor, action, entity, entity_id, meta, created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("executive_cycles")
      .select(
        "id, trigger_type, autonomy_mode, status, skipped_reason, outcome, error, opportunities_considered, actions_attempted, actions_executed, actions_awaiting_approval, actions_failed, started_at, finished_at",
      )
      .order("started_at", { ascending: false })
      .limit(40),
    supabase
      .from("ai_tasks")
      .select("id, worker_key, title, kind, status, steps, lead_id, approved_by, created_at")
      .order("created_at", { ascending: false })
      .limit(60),
  ]);

  if (activity.error) throw activity.error;

  const rows: AuditRow[] = [];

  for (const row of activity.data ?? []) {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const isExecutiveCycle = row.entity === "executive_cycle";
    rows.push({
      id: `act-${row.id}`,
      at: row.created_at as string,
      category: classifyActivity(row.action as string, meta),
      event: isExecutiveCycle ? "Executive cycle" : row.actor === "human" ? "Human action" : "AI event",
      entity: (row.entity as string | null) ?? null,
      entityId: (row.entity_id as string | null) ?? null,
      actor: row.actor === "human" ? "Agency Owner" : MASTER,
      action: row.action as string,
      state: null,
      result: (meta["error"] as string | undefined) ? "FAILED" : null,
      approver: row.actor === "human" ? "Agency Owner" : null,
      workerKey: (meta["worker_key"] as string | undefined) ?? null,
      leadId: (meta["lead_id"] as string | undefined) ?? null,
    });
  }

  for (const cycle of cycles.data ?? []) {
    rows.push({
      id: `cycle-${cycle.id}`,
      at: (cycle.finished_at ?? cycle.started_at) as string,
      category: cycle.status === "failed" ? "failure" : "decision",
      event: "Orchestration cycle",
      entity: "executive_cycle",
      entityId: cycle.id as string,
      actor: MASTER,
      action: `${cycle.trigger_type === "manual" ? "Manual" : "Scheduled"} cycle · ${cycle.opportunities_considered} considered · ${cycle.actions_executed} executed · ${cycle.actions_awaiting_approval} awaiting approval · ${cycle.actions_failed} failed`,
      state: String(cycle.status).toUpperCase(),
      result: (cycle.error as string | null) ?? (cycle.skipped_reason as string | null) ?? null,
      approver: null,
      workerKey: null,
      leadId: null,
    });
  }

  for (const task of (tasks.data ?? []) as unknown as (EngineTask & {
    approved_by: string | null;
  })[]) {
    const steps: EngineTaskStep[] = Array.isArray(task.steps) ? task.steps : [];
    steps.forEach((step, index) => {
      rows.push({
        id: `task-${task.id}-${index}`,
        at: step.at,
        category: classifyStep(step.status),
        event: STEP_EVENT[step.status] ?? "Task step",
        entity: "ai_task",
        entityId: task.id,
        actor:
          step.status === "recommended" || step.status === "waiting_approval"
            ? MASTER
            : WORKER_LABELS[task.worker_key] ?? task.worker_key,
        action: `${task.title} — ${step.note}`,
        state: step.status.toUpperCase(),
        result: step.status === "failed" ? "FAILED" : step.status === "completed" ? "COMPLETED" : null,
        approver: task.approved_by ? "Agency Owner" : null,
        workerKey: task.worker_key,
        leadId: task.lead_id,
      });
    });
  }

  return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
