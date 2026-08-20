import type { SupabaseClient } from "@supabase/supabase-js";

import { WORKER_LABELS } from "@/lib/worker-labels";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * Executive action lifecycle — REAL execution only.
 *
 * CREATED → RECOMMENDED → PENDING_APPROVAL → APPROVED → EXECUTING →
 * COMPLETED | FAILED | REJECTED | ESCALATED
 *
 * An executive decision that requires human approval is persisted as a real
 * `ai_tasks` row (kind = `executive_action`, status = `waiting_approval`).
 * Approving it performs the governed side effect; only a successful side
 * effect marks the task completed. Nothing is ever marked complete because a
 * recommendation was produced.
 */

export const EXECUTIVE_ACTION_KIND = "executive_action";

const HOUR = 60 * 60 * 1000;

export type ApprovalRequestInput = {
  leadId: string;
  objective: string;
  workerKey: string;
  title: string;
  reason: string;
  expectedOutcome: string;
  priority: "low" | "medium" | "high";
  decisionConfidence: number;
  bookingProbability: number | null;
  correlationId: string;
};

export type ApprovalRequestResult =
  | { status: "created"; taskId: string }
  | { status: "duplicate"; taskId: string; reason: string };

/** Idempotent: one open executive action per (lead, objective). */
export async function createApprovalRequest(
  supabase: Db,
  agencyId: string,
  input: ApprovalRequestInput,
): Promise<ApprovalRequestResult> {
  const { data: open } = await supabase
    .from("ai_tasks")
    .select("id, input")
    .eq("agency_id", agencyId)
    .eq("kind", EXECUTIVE_ACTION_KIND)
    .eq("lead_id", input.leadId)
    .in("status", ["queued", "analysing", "planning", "running", "waiting_approval"])
    .limit(20);

  const duplicate = (open ?? []).find(
    (row: any) => (row.input?.objective ?? "") === input.objective,
  );
  if (duplicate)
    return {
      status: "duplicate",
      taskId: duplicate.id as string,
      reason:
        "An equivalent executive action for this lead and objective is already awaiting a decision.",
    };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("ai_tasks")
    .insert({
      agency_id: agencyId,
      worker_key: input.workerKey,
      title: input.title,
      kind: EXECUTIVE_ACTION_KIND,
      status: "waiting_approval",
      priority: input.priority === "medium" ? "normal" : input.priority,
      origin: "autonomous",
      lead_id: input.leadId,
      requires_approval: true,
      approval_reason: input.reason,
      minutes_saved: 15,
      input: {
        objective: input.objective,
        reason: input.reason,
        expected_outcome: input.expectedOutcome,
        worker: WORKER_LABELS[input.workerKey] ?? input.workerKey,
        decision_confidence: input.decisionConfidence,
        booking_probability: input.bookingProbability,
        correlation_id: input.correlationId,
      },
      plan: [
        "Executive analysed the lead situation",
        "Executive selected the responsible worker",
        "Waiting for human approval",
        "On approval: schedule the governed action and monitor the outcome",
      ],
      steps: [
        { at: now, status: "recommended", note: input.objective },
        { at: now, status: "waiting_approval", note: input.reason },
      ],
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { status: "created", taskId: data.id as string };
}

async function appendStep(supabase: Db, taskId: string, status: string, note: string) {
  const { data } = await supabase.from("ai_tasks").select("steps").eq("id", taskId).maybeSingle();
  const steps = Array.isArray(data?.steps) ? (data!.steps as any[]) : [];
  steps.push({ at: new Date().toISOString(), status, note });
  return steps;
}

export type ExecutiveExecutionResult =
  | { status: "completed"; detail: string }
  | { status: "failed"; detail: string };

/**
 * Performs the REAL side effect behind an approved executive action:
 * an internal follow-up job assigned to the responsible worker. It carries no
 * customer-facing body, so nothing is sent to a customer without a human.
 */
export async function executeApprovedExecutiveAction(
  supabase: Db,
  agencyId: string,
  taskId: string,
  userId?: string,
): Promise<ExecutiveExecutionResult> {
  const { data: task } = await supabase
    .from("ai_tasks")
    .select("id, agency_id, lead_id, worker_key, title, input, status")
    .eq("id", taskId)
    .maybeSingle();

  if (!task) return { status: "failed", detail: "Task not found." };
  if (!task.lead_id)
    return { status: "failed", detail: "This executive action has no target lead." };

  await supabase
    .from("ai_tasks")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      steps: await appendStep(supabase, taskId, "executing", "Assigned worker is executing"),
    })
    .eq("id", taskId);

  const runAt = new Date(Date.now() + HOUR).toISOString();
  const { error } = await supabase.from("followup_jobs").insert({
    agency_id: agencyId,
    lead_id: task.lead_id,
    title: task.title,
    channel: "whatsapp",
    run_at: runAt,
    status: "pending",
    context: {
      source: "executive_action",
      task_id: taskId,
      objective: (task.input as any)?.objective ?? null,
      approved_by: userId ?? null,
    },
  });

  if (error) {
    const detail = `Execution failed: ${error.message}`;
    await supabase
      .from("ai_tasks")
      .update({
        status: "failed",
        error: detail,
        completed_at: new Date().toISOString(),
        steps: await appendStep(supabase, taskId, "failed", detail),
      })
      .eq("id", taskId);
    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "ai",
      action: `Executive action FAILED: ${task.title}`,
      entity: "ai_task",
      entity_id: taskId,
      meta: { error: detail },
    });
    return { status: "failed", detail };
  }

  const detail = `Follow-up scheduled for ${runAt} and assigned to ${
    WORKER_LABELS[task.worker_key] ?? task.worker_key
  }.`;
  await supabase
    .from("ai_tasks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      summary: detail,
      output: { executed: true, run_at: runAt },
      steps: await appendStep(supabase, taskId, "completed", detail),
    })
    .eq("id", taskId);

  await supabase.from("activity_log").insert({
    agency_id: agencyId,
    actor: "ai",
    action: `Executive action executed after human approval: ${task.title}`,
    entity: "ai_task",
    entity_id: taskId,
    meta: { lead_id: task.lead_id, run_at: runAt, approved_by: userId ?? null },
  });

  return { status: "completed", detail };
}

/* ------------------------------------------------------------------ */
/* MONITOR — action completed ≠ business outcome achieved              */
/* ------------------------------------------------------------------ */

export type MonitorFinding = {
  taskId: string;
  leadId: string;
  subject: string;
  executedAt: string;
  outcome: "progressed" | "responded" | "no_response" | "unknown";
  detail: string;
  nextAction: string;
};

/** Checks what actually happened after previously executed executive actions. */
export async function monitorExecutedDecisions(
  supabase: Db,
  agencyId: string,
  lookbackHours = 7 * 24,
): Promise<MonitorFinding[]> {
  const since = new Date(Date.now() - lookbackHours * HOUR).toISOString();
  const { data: tasks } = await supabase
    .from("ai_tasks")
    .select("id, lead_id, title, completed_at, output")
    .eq("agency_id", agencyId)
    .eq("kind", EXECUTIVE_ACTION_KIND)
    .eq("status", "completed")
    .gte("completed_at", since)
    .order("completed_at", { ascending: false })
    .limit(20);

  const findings: MonitorFinding[] = [];
  for (const task of tasks ?? []) {
    if (!task.lead_id || !task.completed_at) continue;
    const executedAt = new Date(task.completed_at as string).getTime();
    // Give the action time to produce an outcome before judging it.
    if (Date.now() - executedAt < 6 * HOUR) continue;

    const { data: lead } = await supabase
      .from("leads")
      .select("id, full_name, stage, last_contact_at, updated_at")
      .eq("agency_id", agencyId)
      .eq("id", task.lead_id)
      .maybeSingle();

    if (!lead) {
      findings.push({
        taskId: task.id as string,
        leadId: task.lead_id as string,
        subject: "Unknown lead",
        executedAt: task.completed_at as string,
        outcome: "unknown",
        detail: "The target lead no longer exists, so the outcome cannot be verified.",
        nextAction: "No further action — the opportunity is gone.",
      });
      continue;
    }

    const contacted = lead.last_contact_at
      ? new Date(lead.last_contact_at as string).getTime() > executedAt
      : false;
    const progressed = ["qualified", "negotiation", "booked", "completed"].includes(
      lead.stage as string,
    );

    const outcome: MonitorFinding["outcome"] = contacted
      ? progressed
        ? "progressed"
        : "responded"
      : "no_response";

    findings.push({
      taskId: task.id as string,
      leadId: lead.id as string,
      subject: lead.full_name as string,
      executedAt: task.completed_at as string,
      outcome,
      detail:
        outcome === "progressed"
          ? `Action completed and the opportunity progressed to ${lead.stage}.`
          : outcome === "responded"
            ? `Action completed and the lead engaged, but the stage is still ${lead.stage}.`
            : "Action completed, but no customer engagement has been recorded since.",
      nextAction:
        outcome === "no_response"
          ? "Escalate to a human — repeated automated contact has produced no progress."
          : outcome === "responded"
            ? "Keep the conversation moving toward a booking decision."
            : "No further executive action needed.",
    });
  }
  return findings;
}
