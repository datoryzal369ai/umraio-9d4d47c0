/**
 * AI SALES ELITE™ — real sales intelligence mission.
 *
 * This is NOT a simulation. It reads the agency's live pipeline through the
 * existing Elite desk loader, prioritises real opportunities, and creates
 * governed executive actions through the SAME approval / execution path the
 * autonomous cycle uses (`createApprovalRequest` + `executeApprovedExecutiveAction`).
 *
 * Autonomy boundaries are respected: the mission only executes without asking
 * when the sales_elite worker is enabled AND set to `auto` AND the agency
 * autonomy mode is not `off`. Otherwise every action is parked for approval.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createApprovalRequest,
  executeApprovedExecutiveAction,
} from "@/lib/executive/execution.server";
import { loadEliteDesk, type EliteDeskItem } from "./elite-desk.server";
import { QUALIFIED_SCORE } from "./elite-metrics.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type MissionActionResult =
  | "executed"
  | "approval_required"
  | "duplicate_skipped"
  | "escalated"
  | "failed";

export type MissionAction = {
  leadId: string;
  leadName: string;
  stage: string;
  buyingSignal: string;
  salesStage: string;
  nextBestAction: string;
  confidence: number;
  expectedOutcome: string;
  result: MissionActionResult;
  detail: string;
  taskId: string | null;
};

export type SalesMissionResult = {
  ranAt: string;
  insufficientData: boolean;
  autonomy: "autonomous" | "approval_required" | "paused";
  metrics: {
    leadsAnalysed: number;
    highIntent: number;
    stalledOpportunities: number;
    hotOpportunities: number;
    followupsDue: number;
    approvalRequired: number;
    executed: number;
  };
  actions: MissionAction[];
  summary: string;
};

const MAX_ACTIONS = 3;

const humanise = (v: string) => v.replaceAll("_", " ").toLowerCase();

function objectiveFor(item: EliteDeskItem): string {
  if (item.read.escalate) return "escalate_to_human_consultant";
  return `sales_elite:${item.read.action}`;
}

function expectedOutcomeFor(item: EliteDeskItem): string {
  if (item.read.escalate) return "A human consultant takes over and protects the relationship.";
  if (item.read.closingMode !== "NONE")
    return "The opportunity moves one step closer to a confirmed booking.";
  if (item.read.objectionFocus)
    return `The "${humanise(item.read.objectionFocus)}" objection is resolved and the conversation resumes.`;
  return "The lead re-engages and the missing qualification detail is captured.";
}

export async function runSalesIntelligenceMission(
  supabase: Db,
  agencyId: string,
  userId: string,
): Promise<SalesMissionResult> {
  const ranAt = new Date().toISOString();
  const correlationId = `sales-mission-${Date.now()}`;

  const [desk, workerRes, settingsRes, leadsRes] = await Promise.all([
    loadEliteDesk(supabase),
    supabase
      .from("ai_workers")
      .select("autonomy, is_enabled")
      .eq("agency_id", agencyId)
      .eq("worker_key", "sales_elite")
      .maybeSingle(),
    supabase
      .from("agency_settings")
      .select("autonomy_mode")
      .eq("agency_id", agencyId)
      .maybeSingle(),
    supabase
      .from("leads")
      .select("id, stage, score, last_contact_at, created_at")
      .limit(500),
  ]);

  const worker = workerRes.data as { autonomy?: string; is_enabled?: boolean } | null;
  const autonomyMode = (settingsRes.data as { autonomy_mode?: string } | null)?.autonomy_mode ?? "off";
  const autonomy: SalesMissionResult["autonomy"] =
    worker?.is_enabled === false
      ? "paused"
      : worker?.autonomy === "auto" && autonomyMode !== "off"
        ? "autonomous"
        : "approval_required";

  const leads = (leadsRes.data ?? []) as Array<Record<string, any>>;
  const closed = new Set(["booked", "completed", "lost"]);
  const stalled = leads.filter((l) => {
    if (closed.has(String(l["stage"] ?? ""))) return false;
    if (Number(l["score"] ?? 0) < QUALIFIED_SCORE) return false;
    const last = (l["last_contact_at"] as string | null) ?? (l["created_at"] as string);
    return Date.now() - new Date(last).getTime() > 72 * 3_600_000;
  }).length;

  const hot = desk.items.filter(
    (i) => i.read.psychology.readiness === "high" || i.read.closingMode !== "NONE",
  );

  const candidates = desk.items
    .filter((i) => i.leadId)
    .slice(0, MAX_ACTIONS);

  const actions: MissionAction[] = [];

  for (const item of candidates) {
    const leadId = item.leadId as string;
    const nextBestAction = humanise(item.read.action);
    const base = {
      leadId,
      leadName: item.leadName,
      stage: item.stage,
      salesStage: humanise(item.read.state),
      buyingSignal: item.buyingSignals[0] ?? "No explicit buying signal detected",
      nextBestAction,
      confidence: Math.round(item.read.confidence * 100),
      expectedOutcome: expectedOutcomeFor(item),
    };

    try {
      const request = await createApprovalRequest(supabase, agencyId, {
        leadId,
        objective: objectiveFor(item),
        workerKey: "sales_elite",
        title: `AI SALES ELITE™: ${nextBestAction} — ${item.leadName}`,
        reason: item.read.rationale,
        expectedOutcome: base.expectedOutcome,
        priority: item.read.escalate ? "high" : item.read.psychology.readiness === "high" ? "high" : "medium",
        decisionConfidence: item.read.confidence,
        bookingProbability: null,
        correlationId,
      });

      if (request.status === "duplicate") {
        actions.push({
          ...base,
          result: "duplicate_skipped",
          detail: request.reason,
          taskId: request.taskId,
        });
        continue;
      }

      if (item.read.escalate) {
        actions.push({
          ...base,
          result: "escalated",
          detail:
            item.read.escalationReason ??
            "This conversation needs a human consultant before any further sales action.",
          taskId: request.taskId,
        });
        continue;
      }

      if (autonomy !== "autonomous") {
        actions.push({
          ...base,
          result: "approval_required",
          detail: "Prepared and parked for your approval — autonomy is not enabled for this worker.",
          taskId: request.taskId,
        });
        continue;
      }

      await supabase
        .from("ai_tasks")
        .update({ approved_at: new Date().toISOString(), approved_by: userId })
        .eq("id", request.taskId)
        .eq("status", "waiting_approval");

      const outcome = await executeApprovedExecutiveAction(
        supabase,
        agencyId,
        request.taskId,
        userId,
      );
      actions.push({
        ...base,
        result: outcome.status === "completed" ? "executed" : "failed",
        detail: outcome.detail,
        taskId: request.taskId,
      });
    } catch (error) {
      actions.push({
        ...base,
        result: "failed",
        detail: error instanceof Error ? error.message : "Unknown execution error",
        taskId: null,
      });
    }
  }

  const executed = actions.filter((a) => a.result === "executed").length;
  const approvalRequired = actions.filter((a) => a.result === "approval_required").length;
  const insufficientData = desk.items.length === 0;

  const summary = insufficientData
    ? "INSUFFICIENT DATA — no active conversation carries enough customer signal to act on."
    : `${desk.items.length} live opportunities read · ${executed} executed · ${approvalRequired} awaiting approval.`;

  await supabase.from("activity_log").insert({
    agency_id: agencyId,
    actor: "ai",
    action: `AI SALES ELITE™ sales intelligence mission: ${summary}`,
    entity: "sales_mission",
    meta: {
      correlation_id: correlationId,
      autonomy,
      leads_analysed: desk.metrics.leadsEngaged,
      high_intent: desk.metrics.highIntentLeads,
      stalled,
      hot: hot.length,
      executed,
      approval_required: approvalRequired,
    },
  });

  return {
    ranAt,
    insufficientData,
    autonomy,
    metrics: {
      leadsAnalysed: desk.metrics.leadsEngaged,
      highIntent: desk.metrics.highIntentLeads,
      stalledOpportunities: stalled,
      hotOpportunities: hot.length,
      followupsDue: desk.metrics.followupsDue,
      approvalRequired,
      executed,
    },
    actions,
    summary,
  };
}
