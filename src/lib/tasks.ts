import { supabase } from "@/integrations/supabase/client";

export type EngineTaskStatus =
  | "queued"
  | "analysing"
  | "planning"
  | "running"
  | "processing"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

export type EngineTaskStep = { at: string; status: string; note: string };

/** Executive decision payload persisted on the task when the Executive created it. */
export type EngineTaskInput = {
  objective?: string;
  reason?: string;
  expected_outcome?: string;
  worker?: string;
  decision_confidence?: number;
  booking_probability?: number | null;
  correlation_id?: string;
  [key: string]: unknown;
};

export type EngineTask = {
  id: string;
  worker_key: string;
  title: string;
  kind: string;
  status: EngineTaskStatus;
  priority: "low" | "normal" | "high" | "critical";
  origin: string;
  summary: string | null;
  error: string | null;
  plan: string[] | null;
  steps: EngineTaskStep[] | null;
  output: { summary: string; sections: { heading: string; body: string }[] } | null;
  minutes_saved: number;
  requires_approval: boolean;
  approval_reason: string | null;
  lead_id: string | null;
  input: EngineTaskInput | null;
  approved_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type AppNotification = {
  id: string;
  kind: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  body: string;
  entity: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
};

const TASK_COLUMNS =
  "id, worker_key, title, kind, status, priority, origin, summary, error, plan, steps, output, minutes_saved, requires_approval, approval_reason, created_at, started_at, completed_at";

export async function fetchEngineTasks(limit = 120): Promise<EngineTask[]> {
  const { data, error } = await supabase
    .from("ai_tasks")
    .select(TASK_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as EngineTask[];
}

export async function fetchNotifications(limit = 30): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, severity, title, body, entity, entity_id, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AppNotification[];
}

export const ACTIVE_STATUSES: EngineTaskStatus[] = ["analysing", "planning", "running", "processing"];

export type TaskMetrics = {
  queued: number;
  running: number;
  waitingApproval: number;
  completed: number;
  failed: number;
  cancelled: number;
  avgCompletionSeconds: number | null;
  hoursSaved: number;
  successRate: number | null;
};

export function computeTaskMetrics(tasks: EngineTask[]): TaskMetrics {
  const completed = tasks.filter((t) => t.status === "completed");
  const durations = completed
    .filter((t) => t.completed_at)
    .map(
      (t) =>
        (new Date(t.completed_at!).getTime() -
          new Date(t.started_at ?? t.created_at).getTime()) /
        1000,
    )
    .filter((s) => s > 0 && s < 3600);

  const finished = tasks.filter((t) =>
    ["completed", "failed", "rejected"].includes(t.status),
  ).length;

  return {
    queued: tasks.filter((t) => t.status === "queued").length,
    running: tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
    waitingApproval: tasks.filter((t) => t.status === "waiting_approval").length,
    completed: completed.length,
    failed: tasks.filter((t) => t.status === "failed").length,
    cancelled: tasks.filter((t) => t.status === "cancelled").length,
    avgCompletionSeconds: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
    hoursSaved:
      tasks
        .filter((t) => t.status === "completed" || t.status === "waiting_approval")
        .reduce((s, t) => s + (t.minutes_saved ?? 0), 0) / 60,
    successRate: finished ? (completed.length / finished) * 100 : null,
  };
}

export const TASK_STATUS_LABEL: Record<EngineTaskStatus, string> = {
  queued: "Queued",
  analysing: "Analysing",
  planning: "Planning",
  running: "Running",
  processing: "Running",
  waiting_approval: "Waiting approval",
  completed: "Completed",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const TASK_STATUS_TONE: Record<EngineTaskStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  analysing: "bg-primary/15 text-primary",
  planning: "bg-primary/15 text-primary",
  running: "bg-primary/20 text-primary",
  processing: "bg-primary/20 text-primary",
  waiting_approval: "bg-chart-4/15 text-chart-4",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  rejected: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export const PRIORITY_TONE: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-muted text-muted-foreground",
  high: "bg-chart-4/15 text-chart-4",
  critical: "bg-destructive/15 text-destructive",
};

export function formatDuration(seconds: number | null) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}
