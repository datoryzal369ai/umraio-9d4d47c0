import { supabase } from "@/integrations/supabase/client";

/** Client-side read model for executive orchestration cycles (audit log). */

export type ExecutiveActionResult =
  | "executed"
  | "rejected"
  | "failed"
  | "approval_required"
  | "capability_unavailable"
  | "duplicate_skipped"
  | "escalated"
  | "orchestration_limit_reached";

export type ExecutiveDecision = {
  at: string;
  lead_id: string | null;
  subject: string;
  decision: string;
  why: string;
  action: string | null;
  worker: string | null;
  result: ExecutiveActionResult;
  detail: string;
  /* Orchestration intelligence — optional so historic records still render. */
  objective?: string;
  priority?: "high" | "medium" | "low";
  boundary?: "autonomous" | "human_approval" | "human_only";
  confidence?: number;
  booking_probability?: number | null;
  expected_outcome?: string;
  worker_reason?: string;
  escalation?: Record<string, string> | null;
};

export type ExecutiveCycle = {
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  opportunitiesConsidered: number;
  actionsAttempted: number;
  actionsExecuted: number;
  limitReached: boolean;
  decisions: ExecutiveDecision[];
};

export const RESULT_LABEL: Record<ExecutiveActionResult, string> = {
  executed: "Executed",
  escalated: "Escalated",
  rejected: "Rejected",
  failed: "Failed",
  approval_required: "Waiting for approval",
  capability_unavailable: "Capability unavailable",
  duplicate_skipped: "Skipped (duplicate)",
  orchestration_limit_reached: "Cycle limit reached",
};

export const RESULT_TONE: Record<ExecutiveActionResult, string> = {
  executed: "bg-success/15 text-success",
  escalated: "bg-chart-4/15 text-chart-4",
  rejected: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
  approval_required: "bg-chart-4/15 text-chart-4",
  capability_unavailable: "bg-muted text-muted-foreground",
  duplicate_skipped: "bg-muted text-muted-foreground",
  orchestration_limit_reached: "bg-muted text-muted-foreground",
};

export async function fetchLastExecutiveCycle(): Promise<ExecutiveCycle | null> {
  const { data, error } = await supabase
    .from("activity_log")
    .select("meta, created_at")
    .eq("entity", "executive_cycle")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const meta = (data ?? [])[0]?.meta as ExecutiveCycle | undefined;
  if (!meta || !Array.isArray(meta.decisions)) return null;
  return meta;
}

/* ---------------- STEP 4A: controlled autonomous execution ---------------- */

export type AutonomyMode = "off" | "assisted" | "autonomous";

export const AUTONOMY_LABEL: Record<AutonomyMode, string> = {
  off: "Off",
  assisted: "Assisted",
  autonomous: "Autonomous",
};

export const AUTONOMY_TONE: Record<AutonomyMode, string> = {
  off: "bg-muted text-muted-foreground",
  assisted: "bg-chart-4/15 text-chart-4",
  autonomous: "bg-success/15 text-success",
};

export type CycleRecord = {
  id: string;
  trigger_type: "manual" | "scheduled_autonomous";
  autonomy_mode: AutonomyMode;
  status: "running" | "completed" | "failed" | "skipped";
  skipped_reason: string | null;
  outcome: string | null;
  error: string | null;
  opportunities_considered: number;
  actions_attempted: number;
  actions_executed: number;
  actions_rejected: number;
  actions_awaiting_approval: number;
  actions_failed: number;
  limit_reached: boolean;
  decisions: ExecutiveDecision[];
  started_at: string;
  finished_at: string | null;
};

const CYCLE_COLUMNS =
  "id, trigger_type, autonomy_mode, status, skipped_reason, outcome, error, opportunities_considered, actions_attempted, actions_executed, actions_rejected, actions_awaiting_approval, actions_failed, limit_reached, decisions, started_at, finished_at";

/** Real autonomy state for the Executive Center — never fabricated. */
export async function fetchAutonomyState(): Promise<{
  mode: AutonomyMode;
  cooldownMinutes: number;
  lastCycle: CycleRecord | null;
  lastRunCycle: CycleRecord | null;
  runningCycle: CycleRecord | null;
}> {
  const [{ data: settings }, { data: cycles }] = await Promise.all([
    supabase.from("agency_settings").select("autonomy_mode, autonomy_cooldown_minutes").maybeSingle(),
    supabase
      .from("executive_cycles")
      .select(CYCLE_COLUMNS)
      .order("started_at", { ascending: false })
      .limit(20),
  ]);

  const rows = (cycles ?? []) as unknown as CycleRecord[];
  return {
    mode: ((settings?.autonomy_mode as AutonomyMode | undefined) ?? "off"),
    cooldownMinutes: (settings?.autonomy_cooldown_minutes as number | undefined) ?? 15,
    lastCycle: rows[0] ?? null,
    lastRunCycle: rows.find((r) => r.status === "completed" || r.status === "failed") ?? null,
    runningCycle: rows.find((r) => r.status === "running") ?? null,
  };
}

export const SKIP_LABEL: Record<string, string> = {
  autonomy_off: "Skipped — autonomy is off",
  orchestration_cycle_skipped_active: "Skipped — a cycle was already running",
  orchestration_cycle_skipped_cooldown: "Skipped — cooldown active",
  no_actionable_priority: "Skipped — no actionable priority",
  agency_inactive: "Skipped — agency inactive",
};
