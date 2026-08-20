import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createToolRegistry,
  newCorrelationId,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolOutcome,
} from "./ai/index.server";
import { logAiEvent } from "./ai/audit.server";
import { createIslamicPolicyChecker } from "./islamic/policy.server";

import {
  OPEN_STAGES,
  buildOpportunity,
  type ConvRow,
  type FollowupRow,
  type SalesOpportunity,
} from "./sales-opportunities.core";
import type { Lead } from "./leads";
import { APPROVAL_REQUIRED_KINDS, createTask, notify } from "./task-engine.server";
import { TASK_KINDS } from "./executive-ai.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * Autonomous AI Business Executive™ — governed orchestration cycle.
 *
 * UNDERSTAND → ANALYSE → PRIORITISE → DECIDE → COORDINATE → EXECUTE (through
 * the EXISTING ToolRegistry decision gate) → OBSERVE → RECORD → STOP/ESCALATE.
 *
 * Design constraints (deliberate, do not relax):
 * - Prioritisation and action selection are DETERMINISTIC. No model call is
 *   made in this loop, so no decision or outcome can be fabricated.
 * - The executive never writes to the database directly. Every side effect
 *   goes through `registry.invoke()` (allowlist → schema → permission →
 *   business rule → execution → audit).
 * - No customer-facing message is ever sent autonomously.
 * - Hard action ceiling per cycle; no recursion.
 */

export const MAX_ACTIONS_PER_CYCLE = 3;
const MAX_CANDIDATES = 12;
const HOURS = 60 * 60 * 1000;

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
  /** What the executive decided. */
  decision: string;
  /** Why, from real signals only. */
  why: string;
  /** The governed tool that was (or would be) used. */
  action: string | null;
  /** Which worker owns the execution path. */
  worker: string | null;
  result: ExecutiveActionResult;
  detail: string;
};

export type ExecutiveCycleResult = {
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  triggerType: "manual" | "scheduled_autonomous";
  advisoryOnly: boolean;
  opportunitiesConsidered: number;
  actionsAttempted: number;
  actionsExecuted: number;
  limitReached: boolean;
  decisions: ExecutiveDecision[];
};

/* ------------------------------------------------------------------ */
/* Governed executive tools (registered on the EXISTING ToolRegistry)  */
/* ------------------------------------------------------------------ */

function buildExecutiveRegistry() {
  const tools: ToolDefinition[] = [
    {
      name: "executive_schedule_followup",
      description:
        "Schedule an internal follow-up job for a lead so a human or the WhatsApp worker picks it up. Never sends anything to the customer.",
      permission: "write",
      deterministicSafe: true,
      inputSchema: z.object({
        lead_id: z.string(),
        title: z.string(),
        hours_from_now: z.number(),
      }),
      validate: async (input, tctx) => {
        if (!input.title.trim()) return "A follow-up title is required.";
        if (input.hours_from_now < 1 || input.hours_from_now > 72)
          return "hours_from_now must be between 1 and 72.";
        // Tenant scope check (defence in depth on top of RLS).
        const { data: lead } = await tctx.supabase
          .from("leads")
          .select("id")
          .eq("agency_id", tctx.agencyId)
          .eq("id", input.lead_id)
          .maybeSingle();
        if (!lead) return "Lead does not belong to this agency.";
        // Idempotency: never stack duplicate pending follow-ups.
        const { data: pending } = await tctx.supabase
          .from("followup_jobs")
          .select("id")
          .eq("agency_id", tctx.agencyId)
          .eq("lead_id", input.lead_id)
          .eq("status", "pending")
          .limit(1);
        if ((pending ?? []).length > 0) return "A pending follow-up already exists for this lead.";
        return null;
      },
      execute: async ({ lead_id, title, hours_from_now }, tctx) => {
        const runAt = new Date(Date.now() + hours_from_now * HOURS);
        const { error } = await tctx.supabase.from("followup_jobs").insert({
          agency_id: tctx.agencyId,
          lead_id,
          title,
          channel: "whatsapp",
          run_at: runAt.toISOString(),
          status: "pending",
        });
        if (error) throw new Error(error.message);
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: `Autonomous AI Business Executive scheduled follow-up: ${title}`,
          entity: "lead",
          entity_id: lead_id,
          meta: { run_at: runAt.toISOString(), correlation_id: tctx.correlationId },
        });
        return { scheduled: true, run_at: runAt.toISOString() };
      },
    },

    {
      name: "executive_escalate_to_human",
      description:
        "Raise a human-attention notification for a lead or conversation that the workforce cannot safely handle.",
      permission: "write",
      deterministicSafe: true,
      inputSchema: z.object({
        lead_id: z.string(),
        conversation_id: z.string().nullable(),
        reason: z.string(),
      }),
      validate: async (input, tctx) => {
        if (!input.reason.trim()) return "An escalation reason is required.";
        const { data: lead } = await tctx.supabase
          .from("leads")
          .select("id")
          .eq("agency_id", tctx.agencyId)
          .eq("id", input.lead_id)
          .maybeSingle();
        if (!lead) return "Lead does not belong to this agency.";
        // Idempotency: one open executive escalation per lead.
        const { data: existing } = await tctx.supabase
          .from("notifications")
          .select("id")
          .eq("agency_id", tctx.agencyId)
          .eq("kind", "executive_escalation")
          .eq("entity_id", input.lead_id)
          .is("read_at", null)
          .limit(1);
        if ((existing ?? []).length > 0)
          return "An unread executive escalation already exists for this lead.";
        return null;
      },
      execute: async ({ lead_id, conversation_id, reason }, tctx) => {
        await notify(tctx.supabase, tctx.agencyId, {
          kind: "executive_escalation",
          severity: "warning",
          title: "AI Business Executive escalated a lead",
          body: reason,
          entity: "lead",
          entityId: lead_id,
          meta: { conversation_id, correlation_id: tctx.correlationId },
        });
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: `Autonomous AI Business Executive escalated to human: ${reason}`,
          entity: "lead",
          entity_id: lead_id,
          meta: { conversation_id, correlation_id: tctx.correlationId },
        });
        return { escalated: true };
      },
    },

    {
      name: "executive_queue_worker_task",
      description:
        "Queue an EXISTING specialist-worker task through the existing task engine. Approval-required kinds are never queued autonomously.",
      permission: "write",
      deterministicSafe: true,
      inputSchema: z.object({ kind: z.string(), brief: z.string() }),
      validate: async (input, tctx) => {
        if (!TASK_KINDS[input.kind]) return `Unknown task kind: ${input.kind}`;
        if (APPROVAL_REQUIRED_KINDS.has(input.kind))
          return `"${input.kind}" requires human approval and cannot be queued autonomously.`;
        // Idempotency: do not stack the same kind while one is unfinished.
        const { data: open } = await tctx.supabase
          .from("ai_tasks")
          .select("id")
          .eq("agency_id", tctx.agencyId)
          .eq("kind", input.kind)
          .in("status", ["queued", "analysing", "planning", "running", "waiting_approval"])
          .limit(1);
        if ((open ?? []).length > 0) return `A ${input.kind} task is already in progress.`;
        return null;
      },
      execute: async ({ kind, brief }, tctx) => {
        // Queued only — execution stays with the existing task engine/queue.
        const taskId = await createTask(tctx.supabase, tctx.agencyId, {
          kind,
          brief,
          origin: "autonomous",
          priority: "high",
        });
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: `Autonomous AI Business Executive coordinated ${TASK_KINDS[kind]!.label}`,
          entity: "ai_task",
          entity_id: taskId,
          meta: { kind, correlation_id: tctx.correlationId },
        });
        return { queued: true, task_id: taskId, worker: TASK_KINDS[kind]!.worker };
      },
    },

    {
      name: "executive_request_approval",
      description:
        "Persist an executive decision that requires human authorisation as a real ai_tasks record in waiting_approval. Never executes anything itself.",
      permission: "write",
      deterministicSafe: true,
      inputSchema: z.object({
        lead_id: z.string(),
        objective: z.string(),
        worker_key: z.string(),
        title: z.string(),
        reason: z.string(),
        expected_outcome: z.string(),
        priority: z.enum(["low", "medium", "high"]),
        decision_confidence: z.number(),
        booking_probability: z.number().nullable(),
      }),
      validate: async (input, tctx) => {
        const { data: lead } = await tctx.supabase
          .from("leads")
          .select("id")
          .eq("agency_id", tctx.agencyId)
          .eq("id", input.lead_id)
          .maybeSingle();
        if (!lead) return "Lead does not belong to this agency.";
        const { data: worker } = await tctx.supabase
          .from("ai_workers")
          .select("worker_key")
          .eq("agency_id", tctx.agencyId)
          .eq("worker_key", input.worker_key)
          .maybeSingle();
        if (!worker) return `Worker "${input.worker_key}" is not available for this agency.`;
        // Idempotency: one open executive action per (lead, objective).
        const { data: open } = await tctx.supabase
          .from("ai_tasks")
          .select("id, input")
          .eq("agency_id", tctx.agencyId)
          .eq("kind", "executive_action")
          .eq("lead_id", input.lead_id)
          .in("status", ["queued", "analysing", "planning", "running", "waiting_approval"])
          .limit(20);
        if (
          (open ?? []).some((row: any) => (row.input?.objective ?? "") === input.objective)
        )
          return "An equivalent executive action for this lead and objective is already awaiting a decision.";
        return null;
      },
      execute: async (input, tctx) => {
        const { createApprovalRequest } = await import("./executive/execution.server");
        const result = await createApprovalRequest(tctx.supabase, tctx.agencyId, {
          leadId: input.lead_id,
          objective: input.objective,
          workerKey: input.worker_key,
          title: input.title,
          reason: input.reason,
          expectedOutcome: input.expected_outcome,
          priority: input.priority,
          decisionConfidence: input.decision_confidence,
          bookingProbability: input.booking_probability,
          correlationId: tctx.correlationId,
        });
        if (result.status === "duplicate") throw new Error(result.reason);
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: `Autonomous AI Business Executive requested approval: ${input.title}`,
          entity: "ai_task",
          entity_id: result.taskId,
          meta: {
            lead_id: input.lead_id,
            objective: input.objective,
            correlation_id: tctx.correlationId,
          },
        });
        return { approval_requested: true, task_id: result.taskId };
      },
    },
  ];

  return createToolRegistry(tools);
}

/* ------------------------------------------------------------------ */
/* Context loading (tenant-scoped)                                     */
/* ------------------------------------------------------------------ */

export async function loadOpportunities(supabase: Db, agencyId: string): Promise<SalesOpportunity[]> {
  const [leads, convs, followups] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "id, agency_id, full_name, phone, email, source, stage, temperature, tags, score, budget_myr, pax, preferred_month, last_contact_at, created_at, updated_at",
      )
      .eq("agency_id", agencyId)
      .order("created_at", { ascending: false })
      .limit(300),
    supabase
      .from("conversations")
      .select("id, lead_id, ai_enabled, human_attention_required, last_message_at")
      .eq("agency_id", agencyId)
      .order("last_message_at", { ascending: false })
      .limit(500),
    supabase
      .from("followup_jobs")
      .select("lead_id, run_at, status")
      .eq("agency_id", agencyId)
      .eq("status", "pending")
      .limit(500),
  ]);

  const convByLead = new Map<string, ConvRow>();
  for (const row of ((convs.data ?? []) as ConvRow[])) {
    if (row.lead_id && !convByLead.has(row.lead_id)) convByLead.set(row.lead_id, row);
  }
  const followupByLead = new Map<string, FollowupRow>();
  for (const row of ((followups.data ?? []) as FollowupRow[])) {
    if (!row.lead_id) continue;
    const existing = followupByLead.get(row.lead_id);
    if (!existing || row.run_at < existing.run_at) followupByLead.set(row.lead_id, row);
  }

  return ((leads.data ?? []) as Lead[])
    .filter((lead) => OPEN_STAGES.includes(lead.stage))
    .map((lead) =>
      buildOpportunity(lead, convByLead.get(lead.id) ?? null, followupByLead.get(lead.id) ?? null),
    )
    .filter((opp) => opp.reasons.length > 0)
    .sort((a, b) => b.urgency - a.urgency);
}

/* ------------------------------------------------------------------ */
/* Decision selection — delegated to the pure decision core            */
/* ------------------------------------------------------------------ */
// See ./executive/decision.core.ts: UNDERSTAND → PRIORITISE → DECIDE →
// COORDINATE, all deterministic so no outcome can be fabricated.

/* ------------------------------------------------------------------ */
/* Orchestration cycle                                                 */
/* ------------------------------------------------------------------ */

export type OrchestrationOptions = {
  /** MANUAL (user pressed run) vs SCHEDULED_AUTONOMOUS (server-side cycle). */
  triggerType?: "manual" | "scheduled_autonomous";
  /** ASSISTED mode: plan and record, but never perform a side effect. */
  advisoryOnly?: boolean;
};

export async function runExecutiveOrchestration(
  supabase: Db,
  agencyId: string,
  userId?: string,
  options: OrchestrationOptions = {},
): Promise<ExecutiveCycleResult> {
  const advisoryOnly = options.advisoryOnly === true;
  const triggerType = options.triggerType ?? "manual";
  const correlationId = newCorrelationId();
  const startedAt = new Date().toISOString();
  const registry = buildExecutiveRegistry();
  const toolCtx: ToolExecutionContext = {
    supabase,
    agencyId,
    userId,
    correlationId,
    grantedPermissions: ["read", "write"],
    allowedTools: registry.names(),
    islamicPolicy: createIslamicPolicyChecker(supabase, agencyId),

  };

  await logAiEvent(supabase, {
    agencyId,
    correlationId,
    event: "AI_REQUEST",
    taskType: "business_decision",
    stage: "orchestration_start",
    userId,
  });

  const opportunities = await loadOpportunities(supabase, agencyId);
  const candidates = opportunities.slice(0, MAX_CANDIDATES);

  const decisions: ExecutiveDecision[] = [];
  let executed = 0;
  let attempted = 0;
  let limitReached = false;

  for (const [index, opp] of candidates.entries()) {
    if (executed >= MAX_ACTIONS_PER_CYCLE) {
      limitReached = true;
      decisions.push({
        at: new Date().toISOString(),
        lead_id: null,
        subject: "Cycle boundary",
        decision: "Stop this cycle",
        why: `Maximum of ${MAX_ACTIONS_PER_CYCLE} governed actions per cycle reached.`,
        action: null,
        worker: null,
        result: "orchestration_limit_reached",
        detail: `${candidates.length - index} remaining priorities carry over to the next cycle.`,
      });
      break;
    }


    const plan = planFor(opp);
    const why = `${opp.reasons.join(", ")} · score ${opp.lead.score}/100 · ${opp.intent} intent`;

    if (plan.tool === null) {
      decisions.push({
        at: new Date().toISOString(),
        lead_id: opp.lead.id,
        subject: opp.lead.full_name,
        decision: plan.decision,
        why,
        action: null,
        worker: null,
        result: "capability_unavailable",
        detail: plan.detail,
      });
      continue;
    }

    if (advisoryOnly) {
      // ASSISTED mode: recommend only. No governed side effect is performed.
      decisions.push({
        at: new Date().toISOString(),
        lead_id: opp.lead.id,
        subject: opp.lead.full_name,
        decision: plan.decision,
        why,
        action: plan.tool,
        worker: plan.worker,
        result: "approval_required",
        detail:
          "Assisted autonomy mode — recommendation recorded. A human must approve before this action runs.",
      });
      continue;
    }

    attempted += 1;
    const outcome: ToolOutcome = await registry.invoke(plan.tool, plan.input, toolCtx);

    let result: ExecutiveActionResult;
    let detail: string;
    if (outcome.status === "executed") {
      result = plan.tool === "executive_escalate_to_human" ? "escalated" : "executed";
      detail = JSON.stringify(outcome.result);
      executed += 1;
    } else if (outcome.status === "rejected") {
      result = outcome.stage === "business_rule" ? "duplicate_skipped" : "rejected";
      detail = outcome.reason;
    } else {
      result = "failed";
      detail = outcome.reason;
    }

    decisions.push({
      at: new Date().toISOString(),
      lead_id: opp.lead.id,
      subject: opp.lead.full_name,
      decision: plan.decision,
      why,
      action: plan.tool,
      worker: plan.worker,
      result,
      detail,
    });
  }

  // Workforce coordination: keep Lead Intelligence scoring fresh when the
  // pipeline has unattended priorities. Queued only — the existing task engine
  // executes it, so nothing here bypasses the worker path.
  if (!advisoryOnly && executed < MAX_ACTIONS_PER_CYCLE && candidates.length >= 3) {
    const coordinationKind = "lead_scoring";
    attempted += 1;
    const outcome = await registry.invoke(
      "executive_queue_worker_task",
      {
        kind: coordinationKind,
        brief: `Executive orchestration: ${candidates.length} open priorities detected — rescore and re-prioritise the pipeline.`,
      },
      toolCtx,
    );
    const executedOk = outcome.status === "executed";
    if (executedOk) executed += 1;

    // Deterministic outcome classification — never inferred from message text.
    let coordinationResult: ExecutiveActionResult;
    if (executedOk) {
      coordinationResult = "executed";
    } else if (outcome.status === "rejected") {
      coordinationResult = APPROVAL_REQUIRED_KINDS.has(coordinationKind)
        ? "approval_required"
        : outcome.stage === "business_rule"
          ? "duplicate_skipped"
          : "rejected";
    } else {
      coordinationResult = "failed";
    }

    decisions.push({
      at: new Date().toISOString(),
      lead_id: null,
      subject: "Pipeline",
      decision: "Coordinate AI Lead Intelligence to re-score the pipeline",
      why: `${candidates.length} open priorities detected in this cycle.`,
      action: "executive_queue_worker_task",
      worker: "AI Lead Intelligence",
      result: coordinationResult,
      detail: executedOk
        ? JSON.stringify(outcome.result)
        : outcome.status === "rejected"
          ? outcome.reason
          : outcome.reason,
    });
  }

  const finishedAt = new Date().toISOString();
  const cycle: ExecutiveCycleResult = {
    correlationId,
    startedAt,
    finishedAt,
    triggerType,
    advisoryOnly,
    opportunitiesConsidered: candidates.length,
    actionsAttempted: attempted,
    actionsExecuted: executed,
    limitReached,
    decisions,
  };

  // Append-only audit record for the whole cycle (UI reads this).
  await supabase.from("activity_log").insert({
    agency_id: agencyId,
    actor: "ai",
    action: `Autonomous AI Business Executive ran a ${
      triggerType === "scheduled_autonomous" ? "scheduled autonomous" : "manual"
    } orchestration cycle — ${executed} action(s) executed`,
    entity: "executive_cycle",
    entity_id: null,
    meta: { ...cycle, user_id: userId ?? null },
  });

  await logAiEvent(supabase, {
    agencyId,
    correlationId,
    event: "AI_DECISION",
    taskType: "business_decision",
    stage: "orchestration_end",
    status: limitReached ? "limit_reached" : "completed",
    reasonCode: `considered=${candidates.length} attempted=${attempted} executed=${executed}`,
    userId,
  });

  return cycle;
}
