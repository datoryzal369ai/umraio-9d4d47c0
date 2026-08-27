import type { SupabaseClient } from "@supabase/supabase-js";

import { QuotaError, assertQuota, checkQuota, recordUsageEvent } from "./billing/usage.server";

import {
  TASK_KINDS,
  runDocumentTask,
  runFollowupSweep,
  runLeadIntelligence,
} from "./executive-ai.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type TaskStatus =
  | "queued"
  | "analysing"
  | "planning"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

export type TaskPriority = "low" | "normal" | "high" | "critical";

/** Actions that must never execute without a human decision. */
export const APPROVAL_REQUIRED_KINDS = new Set([
  "facebook_ads",
  "tiktok_ads",
  "google_ads",
  "whatsapp_broadcast",
  "whatsapp_promo",
  "price_change",
  "booking_cancellation",
  "data_deletion",
]);

import { WORKER_LABELS } from "./worker-labels";

export { WORKER_LABELS };

const TASK_PLANS: Record<string, string[]> = {
  lead_scoring: [
    "Observe every open lead in the CRM",
    "Recalculate score and temperature",
    "Detect hot leads and booking probability",
    "Write next action per lead and log to the timeline",
  ],
  followup_sweep: [
    "Observe leads with no contact for 48h+",
    "Draft a personalised WhatsApp follow-up per lead",
    "Schedule follow-up jobs at the best send time",
    "Log every scheduled nudge to the timeline",
  ],
};

function planFor(kind: string): string[] {
  return (
    TASK_PLANS[kind] ?? [
      "Observe agency packages, pipeline and settings",
      "Analyse the brief and pick the strongest angle",
      "Produce ready-to-ship output",
      APPROVAL_REQUIRED_KINDS.has(kind)
        ? "Hand over to a human for approval before publishing"
        : "Publish result to the Executive Center",
    ]
  );
}

type Step = { at: string; status: TaskStatus; note: string };

async function setStatus(
  supabase: Db,
  taskId: string,
  status: TaskStatus,
  note: string,
  extra: Record<string, unknown> = {},
) {
  const { data: current } = await supabase
    .from("ai_tasks")
    .select("steps")
    .eq("id", taskId)
    .maybeSingle();
  const steps: Step[] = Array.isArray(current?.steps) ? (current!.steps as Step[]) : [];
  steps.push({ at: new Date().toISOString(), status, note });
  await supabase
    .from("ai_tasks")
    .update({ status, steps, ...extra })
    .eq("id", taskId);
}

export async function notify(
  supabase: Db,
  agencyId: string,
  input: {
    kind: string;
    title: string;
    body?: string;
    severity?: "info" | "success" | "warning" | "critical";
    entity?: string;
    entityId?: string | null;
    meta?: Record<string, unknown>;
  },
) {
  await supabase.from("notifications").insert({
    agency_id: agencyId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? "",
    severity: input.severity ?? "info",
    entity: input.entity ?? null,
    entity_id: input.entityId ?? null,
    meta: input.meta ?? {},
  });
}

export async function createTask(
  supabase: Db,
  agencyId: string,
  input: {
    kind: string;
    brief?: string;
    priority?: TaskPriority;
    origin?: "manual" | "autonomous" | "webhook";
    createdBy?: string | null;
    leadId?: string | null;
  },
) {
  const spec = TASK_KINDS[input.kind];
  if (!spec) throw new Error(`Unknown task kind: ${input.kind}`);
  const requiresApproval = APPROVAL_REQUIRED_KINDS.has(input.kind);

  const { data, error } = await supabase
    .from("ai_tasks")
    .insert({
      agency_id: agencyId,
      worker_key: spec.worker,
      title: spec.label,
      kind: input.kind,
      status: "queued",
      priority: input.priority ?? "normal",
      origin: input.origin ?? "manual",
      input: { brief: input.brief ?? "" },
      plan: planFor(input.kind),
      steps: [
        {
          at: new Date().toISOString(),
          status: "queued",
          note: "Task queued by the autonomous engine",
        },
      ],
      minutes_saved: spec.minutes,
      requires_approval: requiresApproval,
      approval_reason: requiresApproval
        ? "This action publishes or sends on behalf of the agency."
        : null,
      lead_id: input.leadId ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Runs one task through the full autonomous lifecycle. */
export async function executeTask(supabase: Db, agencyId: string, taskId: string) {
  const { data: task, error } = await supabase
    .from("ai_tasks")
    .select("id, kind, worker_key, title, input, status")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw error;
  if (!task) throw new Error("Task not found");
  if (["completed", "failed", "cancelled", "rejected"].includes(task.status)) return task.status;

  const spec = TASK_KINDS[task.kind]!;
  const brief = (task.input as any)?.brief ?? "";
  const requiresApproval = APPROVAL_REQUIRED_KINDS.has(task.kind);

  await supabase
    .from("ai_workers")
    .update({ status: "processing", last_run_at: new Date().toISOString() })
    .eq("agency_id", agencyId)
    .eq("worker_key", task.worker_key);

  try {
    // COMMERCIAL SAFETY — AI worker tasks consume the ai_tasks allowance.
    // Checked before any model call and fails closed.
    await assertQuota(supabase, agencyId, "ai_task");

    await setStatus(supabase, taskId, "analysing", "Observing agency data and context");
    await setStatus(supabase, taskId, "planning", "Building an execution plan");
    await setStatus(supabase, taskId, "running", "Executing the plan", {
      started_at: new Date().toISOString(),
    });

    let document;
    let suffix = "";
    if (task.kind === "lead_scoring") {
      const res = await runLeadIntelligence(supabase, agencyId, brief);
      document = res.document;
      suffix = ` · ${res.updated} leads rescored`;
    } else if (task.kind === "followup_sweep") {
      const res = await runFollowupSweep(supabase, agencyId, brief);
      document = res.document;
      suffix = ` · ${res.scheduled} follow-ups scheduled`;
    } else {
      document = await runDocumentTask(supabase, agencyId, task.kind, brief);
    }

    const status: TaskStatus = requiresApproval ? "waiting_approval" : "completed";
    await setStatus(
      supabase,
      taskId,
      status,
      requiresApproval
        ? "Waiting for human approval before publishing"
        : "Task completed autonomously",
      {
        output: document,
        summary: `${document.summary}${suffix}`,
        completed_at: new Date().toISOString(),
      },
    );

    await supabase
      .from("ai_workers")
      .update({ status: requiresApproval ? "waiting_approval" : "completed" })
      .eq("agency_id", agencyId)
      .eq("worker_key", task.worker_key);

    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "ai",
      action: `${WORKER_LABELS[task.worker_key] ?? "AI Worker"} ${requiresApproval ? "prepared" : "completed"}: ${spec.label}`,
      entity: "ai_task",
      entity_id: taskId,
      meta: { kind: task.kind, status },
    });

    await notify(supabase, agencyId, {
      kind: requiresApproval ? "approval_required" : "task_completed",
      severity: requiresApproval ? "warning" : "success",
      title: requiresApproval ? `Approval needed: ${spec.label}` : `${spec.label} completed`,
      body: document.summary.slice(0, 400),
      entity: "ai_task",
      entityId: taskId,
    });

    await recordUsageEvent(supabase, {
      agencyId,
      eventKey: `task:${taskId}`,
      category: "ai_task",
      taskType: task.kind,
      operation: "execute_task",
      worker: task.worker_key,
      success: true,
      meta: { kind: task.kind, status },
    });

    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Task failed";
    // A quota block is not consumption — it never counts against the allowance.
    if (!(err instanceof QuotaError))
      await recordUsageEvent(supabase, {
        agencyId,
        eventKey: `task:${taskId}`,
        category: "ai_task",
        taskType: task.kind,
        operation: "execute_task",
        worker: task.worker_key,
        success: false,
        meta: { kind: task.kind, error: message.slice(0, 200) },
      });
    await setStatus(supabase, taskId, "failed", message, {
      error: message,
      completed_at: new Date().toISOString(),
    });
    await supabase
      .from("ai_workers")
      .update({ status: "idle" })
      .eq("agency_id", agencyId)
      .eq("worker_key", task.worker_key);
    await notify(supabase, agencyId, {
      kind: "task_failed",
      severity: "critical",
      title: `Task failed: ${spec.label}`,
      body: message,
      entity: "ai_task",
      entityId: taskId,
    });
    throw new Error(message);
  }
}

const HOURS = 60 * 60 * 1000;

async function lastTaskAt(supabase: Db, agencyId: string, kind: string) {
  const { data } = await supabase
    .from("ai_tasks")
    .select("created_at")
    .eq("agency_id", agencyId)
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ? new Date(data.created_at).getTime() : 0;
}

/**
 * Observe → decide → queue. Creates real tasks from real database state and
 * raises notifications the owner needs to see.
 */
export async function observeAndQueue(supabase: Db, agencyId: string) {
  const now = Date.now();
  const queued: string[] = [];

  // QUOTA STORM GUARD — autonomous cycles must not create tasks the agency
  // cannot run. Non-throwing check; exhausted agencies are skipped silently
  // (no tasks queued, no failed-task spam, no usage consumed).
  try {
    const quota = await checkQuota(supabase, agencyId, "ai_task");
    if (!quota.allowed) return queued;
  } catch {
    // Metering unavailable — fail closed for autonomous work.
    return queued;
  }

  const { data: leads } = await supabase
    .from("leads")
    .select("id, full_name, stage, temperature, score, last_contact_at, created_at, updated_at")
    .eq("agency_id", agencyId)
    .limit(200);
  const open = (leads ?? []).filter((l: any) => !["booked", "completed", "lost"].includes(l.stage));

  // 1. Lead intelligence — rescore when the pipeline moved and we have not scored recently.
  if (open.length > 0 && now - (await lastTaskAt(supabase, agencyId, "lead_scoring")) > 6 * HOURS) {
    queued.push(
      await createTask(supabase, agencyId, {
        kind: "lead_scoring",
        origin: "autonomous",
        priority: "high",
        brief: "Autonomous cycle: recalculate scores, detect hot leads and abandoned enquiries.",
      }),
    );
  }

  // 2. Abandoned enquiries → follow-up sweep.
  const stale = open.filter(
    (l: any) => now - new Date(l.last_contact_at ?? l.created_at).getTime() > 48 * HOURS,
  );
  if (
    stale.length > 0 &&
    now - (await lastTaskAt(supabase, agencyId, "followup_sweep")) > 12 * HOURS
  ) {
    queued.push(
      await createTask(supabase, agencyId, {
        kind: "followup_sweep",
        origin: "autonomous",
        priority: stale.length > 5 ? "high" : "normal",
        brief: `Autonomous cycle: ${stale.length} enquiries have gone quiet for 48h+.`,
      }),
    );
  }

  // 3. Daily marketing plan.
  if (now - (await lastTaskAt(supabase, agencyId, "daily_campaign_plan")) > 20 * HOURS) {
    queued.push(
      await createTask(supabase, agencyId, {
        kind: "daily_campaign_plan",
        origin: "autonomous",
        brief: "Autonomous cycle: today's marketing plan based on live pipeline data.",
      }),
    );
  }

  // 4. Hot lead alerts (only once per lead).
  const hot = open.filter((l: any) => l.temperature === "hot" || (l.score ?? 0) >= 70);
  if (hot.length > 0) {
    const { data: alerted } = await supabase
      .from("notifications")
      .select("entity_id")
      .eq("agency_id", agencyId)
      .eq("kind", "hot_lead");
    const seen = new Set((alerted ?? []).map((n: any) => n.entity_id));
    for (const lead of hot.filter((l: any) => !seen.has(l.id)).slice(0, 10)) {
      await notify(supabase, agencyId, {
        kind: "hot_lead",
        severity: "warning",
        title: `High priority lead: ${lead.full_name}`,
        body: `Score ${lead.score ?? 0}/100 · stage ${lead.stage}. Contact them today.`,
        entity: "lead",
        entityId: lead.id,
      });
    }
  }

  // 5. Booking confirmations.
  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, amount_myr, status, created_at")
    .eq("agency_id", agencyId)
    .gte("created_at", new Date(now - 24 * HOURS).toISOString());
  if ((bookings ?? []).length > 0) {
    const { data: alerted } = await supabase
      .from("notifications")
      .select("entity_id")
      .eq("agency_id", agencyId)
      .eq("kind", "booking_confirmed");
    const seen = new Set((alerted ?? []).map((n: any) => n.entity_id));
    for (const b of (bookings ?? []).filter((b: any) => !seen.has(b.id))) {
      await notify(supabase, agencyId, {
        kind: "booking_confirmed",
        severity: "success",
        title: "Booking confirmed",
        body: `RM ${Number(b.amount_myr ?? 0).toLocaleString("en-MY")} booking recorded.`,
        entity: "booking",
        entityId: b.id,
      });
    }
  }

  return queued;
}

/** Executes queued tasks that are ready to run. */
export async function drainQueue(supabase: Db, agencyId: string, limit = 3) {
  const { data: tasks } = await supabase
    .from("ai_tasks")
    .select("id, priority, created_at")
    .eq("agency_id", agencyId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  const order: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  const sorted = (tasks ?? []).sort(
    (a: any, b: any) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2),
  );

  const results: { id: string; status: string }[] = [];
  for (const task of sorted) {
    try {
      const status = await executeTask(supabase, agencyId, task.id);
      results.push({ id: task.id, status: String(status) });
    } catch {
      results.push({ id: task.id, status: "failed" });
    }
  }
  return results;
}

export async function runAutonomousCycle(supabase: Db, agencyId: string) {
  const queued = await observeAndQueue(supabase, agencyId);
  const executed = await drainQueue(supabase, agencyId);
  // Follow-up dispatch closes the loop: scheduled nudges actually reach the
  // customer, under deterministic safety rules (see dispatcher.server.ts).
  const { dispatchDueFollowups } = await import("./followups/dispatcher.server");
  let followups = { sent: 0, skipped: 0, failed: 0 };
  try {
    const res = await dispatchDueFollowups(supabase, agencyId);
    followups = { sent: res.sent, skipped: res.skipped, failed: res.failed };
  } catch (err) {
    console.error(
      `[task-engine] follow-up dispatch failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  return { queued: queued.length, executed, followups };
}
