import type { SalesOpportunity } from "@/lib/sales-opportunities.core";

/**
 * AI AUTONOMOUS BUSINESS EXECUTIVE™ — orchestration intelligence (PURE).
 *
 * OBSERVE → UNDERSTAND → PRIORITISE → DECIDE → COORDINATE.
 *
 * Deterministic by design: every field below is derived from data the system
 * actually holds. Nothing is inferred from a model, so nothing can be
 * fabricated. Missing data becomes an UNKNOWN, never a fact.
 */

export type PriorityBand = "high" | "medium" | "low";

/** How much the executive is allowed to do by itself for this decision. */
export type AutonomyBoundary = "autonomous" | "human_approval" | "human_only";

export type SituationReport = {
  facts: string[];
  signals: string[];
  interpretations: string[];
  unknowns: string[];
};

export type PriorityAssessment = {
  band: PriorityBand;
  score: number;
  /** One explainable sentence — never a bare number. */
  reason: string;
};

export type ExecutiveActionTool =
  | "executive_schedule_followup"
  | "executive_escalate_to_human"
  | "executive_request_approval"
  | null;

export type EscalationBrief = {
  situation: string;
  customer: string;
  stage: string;
  intent: string;
  mainIssue: string;
  actionsTaken: string;
  recommendedHumanAction: string;
  urgency: PriorityBand;
  reason: string;
};

export type ExecutiveDecisionEnvelope = {
  leadId: string | null;
  subject: string;
  objective: string;
  reason: string;
  recommendedAction: string;
  worker: string;
  workerReason: string;
  expectedOutcome: string;
  priority: PriorityAssessment;
  boundary: AutonomyBoundary;
  /** Confidence that the evidence supports this decision (0-100). */
  decisionConfidence: number;
  /** Only present when real evidence supports an estimate. */
  bookingProbability: number | null;
  /** Governed tool that performs the action, or null when unavailable. */
  tool: ExecutiveActionTool;
  toolInput: Record<string, unknown> | null;
  /** Populated only for human_only decisions. */
  escalation: EscalationBrief | null;
  /** Set when no capability exists to perform the recommended action. */
  unavailableReason: string | null;
};

const DAY = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* UNDERSTAND                                                          */
/* ------------------------------------------------------------------ */

export function assessSituation(
  opportunities: SalesOpportunity[],
  workforce: { enabled: number; total: number },
): SituationReport {
  const facts: string[] = [];
  const signals: string[] = [];
  const interpretations: string[] = [];
  const unknowns: string[] = [];

  const high = opportunities.filter((o) => o.intent === "high");
  const attention = opportunities.filter((o) => o.humanAttention || o.aiPaused);
  const noContact = opportunities.filter((o) => o.reasons.includes("no_contact"));
  const awaiting = opportunities.filter((o) => o.reasons.includes("awaiting_reply"));
  const due = opportunities.filter((o) => o.reasons.includes("followup_due"));
  const missing = opportunities.filter((o) => o.missing.length > 0);

  facts.push(`${opportunities.length} open opportunity(ies) in the pipeline right now.`);
  facts.push(`${workforce.enabled}/${workforce.total} AI workers are enabled.`);
  if (due.length) facts.push(`${due.length} scheduled follow-up(s) are due.`);

  if (high.length) signals.push(`${high.length} lead(s) show high buying intent.`);
  if (noContact.length) signals.push(`${noContact.length} lead(s) have never been contacted.`);
  if (awaiting.length) signals.push(`${awaiting.length} lead(s) have not replied for 24h+.`);
  if (attention.length)
    signals.push(`${attention.length} conversation(s) are flagged for human attention.`);

  if (attention.length)
    interpretations.push(
      "Human-flagged conversations outrank everything else: automation there risks damaging trust.",
    );
  if (high.length && awaiting.length)
    interpretations.push(
      "High-intent leads going quiet usually means an unresolved objection or a timing issue, not lost interest.",
    );
  if (!opportunities.length)
    interpretations.push("Nothing requires executive action — the pipeline is fully attended.");
  if (workforce.enabled < workforce.total)
    interpretations.push(
      "Part of the workforce is paused, so some recommended actions cannot be delegated.",
    );

  if (missing.length)
    unknowns.push(
      `${missing.length} lead(s) are missing qualification data (${[
        ...new Set(missing.flatMap((o) => o.missing)),
      ].join(", ")}).`,
    );
  unknowns.push(
    "Customer replies that arrived outside connected channels are not visible to the executive.",
  );

  return { facts, signals, interpretations, unknowns };
}

/* ------------------------------------------------------------------ */
/* PRIORITISE                                                          */
/* ------------------------------------------------------------------ */

export function prioritise(opp: SalesOpportunity): PriorityAssessment {
  const parts: string[] = [];
  if (opp.aiPaused) parts.push("the customer asked for a human");
  else if (opp.humanAttention) parts.push("the conversation was flagged for human attention");
  if (opp.intent === "high") parts.push(`buying intent is high (score ${opp.lead.score}/100)`);
  if (opp.reasons.includes("followup_due")) parts.push("a scheduled follow-up is already due");
  if (opp.reasons.includes("no_contact")) parts.push("the lead has never been contacted");
  if (opp.reasons.includes("awaiting_reply")) parts.push("there has been no reply for over 24 hours");
  if (opp.lead.stage === "qualified" || opp.lead.stage === "negotiation")
    parts.push(`the lead already reached the ${opp.lead.stage} stage`);
  if (opp.missing.length) parts.push(`qualification data is incomplete (${opp.missing.join(", ")})`);

  const band: PriorityBand =
    opp.urgency >= 110 || opp.humanAttention || opp.aiPaused
      ? "high"
      : opp.urgency >= 60
        ? "medium"
        : "low";

  return {
    band,
    score: opp.urgency,
    reason: parts.length
      ? `${parts[0]!.charAt(0).toUpperCase()}${parts[0]!.slice(1)}${
          parts.length > 1 ? `, and ${parts.slice(1).join(", ")}` : ""
        }.`
      : "No distinguishing signal — ranked on lead score only.",
  };
}

/* ------------------------------------------------------------------ */
/* DECIDE + COORDINATE                                                 */
/* ------------------------------------------------------------------ */

/**
 * Decision confidence = confidence that the EVIDENCE supports the action.
 * It is intentionally unrelated to booking probability.
 */
function confidenceFor(opp: SalesOpportunity, evidenceStrength: number): number {
  let c = evidenceStrength;
  if (opp.missing.length >= 3) c -= 20;
  else if (opp.missing.length) c -= opp.missing.length * 5;
  if (!opp.lead.last_contact_at && !opp.lastCustomerMessageAt) c -= 10;
  return Math.max(20, Math.min(99, Math.round(c)));
}

/**
 * Booking probability is only produced where real evidence exists
 * (stage progression + engagement). Otherwise it stays null — never guessed.
 */
function bookingProbabilityFor(opp: SalesOpportunity): number | null {
  const lead = opp.lead;
  if (!lead.last_contact_at) return null;
  if (opp.missing.length >= 3) return null;
  const stageWeight: Record<string, number> = {
    new: 10,
    contacted: 20,
    qualified: 40,
    proposal: 60,
    negotiation: 75,
    booked: 95,
  };
  const base = stageWeight[lead.stage];
  if (base === undefined) return null;
  const recencyDays = (Date.now() - new Date(lead.last_contact_at).getTime()) / DAY;
  const decay = Math.min(25, Math.floor(recencyDays) * 3);
  return Math.max(5, Math.min(95, Math.round(base + lead.score * 0.2 - decay)));
}

export function escalationBrief(opp: SalesOpportunity, reason: string): EscalationBrief {
  const lead = opp.lead;
  return {
    situation: opp.aiPaused
      ? "The customer explicitly asked for a human, so AI replies are paused on this conversation."
      : "The AI workforce flagged this conversation as requiring human judgement.",
    customer: `${lead.full_name}${lead.phone ? ` · ${lead.phone}` : ""}`,
    stage: lead.stage,
    intent: `${opp.intent} (score ${lead.score}/100)`,
    mainIssue: reason,
    actionsTaken: opp.pendingFollowupAt
      ? `A follow-up is already scheduled for ${opp.pendingFollowupAt}.`
      : "No autonomous customer-facing action was taken on this lead.",
    recommendedHumanAction: opp.nextAction,
    urgency: prioritise(opp).band,
    reason,
  };
}

export function decideFor(opp: SalesOpportunity): ExecutiveDecisionEnvelope {
  const lead = opp.lead;
  const priority = prioritise(opp);
  const bookingProbability = bookingProbabilityFor(opp);

  const base = {
    leadId: lead.id,
    subject: lead.full_name,
    priority,
    bookingProbability,
    escalation: null as EscalationBrief | null,
    unavailableReason: null as string | null,
  };

  // HUMAN ONLY — the executive prepares a handoff and must not execute.
  if (opp.aiPaused || opp.humanAttention) {
    const reason = opp.aiPaused
      ? `${lead.full_name} asked for a human — AI replies are paused on this conversation.`
      : `${lead.full_name} was flagged for human attention by the WhatsApp worker.`;
    return {
      ...base,
      objective: "Hand this conversation to a human colleague without delay",
      reason,
      recommendedAction: "Escalate with a human handoff brief",
      worker: "Human team",
      workerReason:
        "Customer-requested or AI-flagged conversations are outside autonomous authority.",
      expectedOutcome: "A human replies personally and restores trust in the conversation.",
      boundary: "human_only",
      decisionConfidence: confidenceFor(opp, 95),
      tool: "executive_escalate_to_human",
      toolInput: { lead_id: lead.id, conversation_id: opp.conversationId, reason },
      escalation: escalationBrief(opp, reason),
    };
  }

  // A due follow-up already owns this lead — duplicate protection.
  if (opp.reasons.includes("followup_due")) {
    return {
      ...base,
      objective: "Avoid double-contacting a lead that already has a due follow-up",
      reason: "A follow-up job is already pending and due for this lead.",
      recommendedAction: "Leave the due follow-up with its existing owner",
      worker: "AI WhatsApp Executive",
      workerReason: "The follow-up dispatcher already owns this lead's next contact.",
      expectedOutcome: "The scheduled follow-up runs once, not twice.",
      boundary: "autonomous",
      decisionConfidence: confidenceFor(opp, 90),
      tool: null,
      toolInput: null,
      unavailableReason: "Duplicate prevented — an equivalent pending follow-up already exists.",
    };
  }

  // AUTONOMOUS — internal scheduling only, never a customer-facing send.
  if (opp.reasons.includes("no_contact") || opp.reasons.includes("awaiting_reply")) {
    const first = opp.reasons.includes("no_contact");
    return {
      ...base,
      objective: first
        ? `Open first contact and qualify ${lead.full_name}`
        : `Re-engage ${lead.full_name} after 24h+ of silence`,
      reason: priority.reason,
      recommendedAction: first
        ? "Schedule a qualification follow-up"
        : "Schedule a re-engagement follow-up",
      worker: "AI WhatsApp Executive",
      workerReason:
        "Inbound and outbound WhatsApp contact is the WhatsApp Executive's operating domain.",
      expectedOutcome: first
        ? "The lead is contacted and qualification data is captured."
        : "The lead responds and the opportunity moves forward.",
      boundary: "autonomous",
      decisionConfidence: confidenceFor(opp, first ? 85 : 80),
      tool: "executive_schedule_followup",
      toolInput: {
        lead_id: lead.id,
        title: first
          ? `First contact: qualify ${lead.full_name}`
          : `Re-engage ${lead.full_name} — no reply in 24h+`,
        hours_from_now: opp.intent === "high" ? 1 : 4,
      },
    };
  }

  // HUMAN APPROVAL — high-intent outbound push is prepared, never auto-sent.
  if (opp.intent === "high") {
    const objective = `Move ${lead.full_name} from ${lead.stage} toward a booking decision`;
    return {
      ...base,
      objective,
      reason: priority.reason,
      recommendedAction: "Personalised package recommendation and closing push",
      worker: "AI SALES ELITE™",
      workerReason:
        "High buying intent with a pending decision is a closing problem, which AI SALES ELITE™ owns.",
      expectedOutcome: "The lead receives a tailored recommendation and progresses toward booking.",
      boundary: "human_approval",
      decisionConfidence: confidenceFor(opp, 75),
      tool: "executive_request_approval",
      toolInput: {
        lead_id: lead.id,
        objective,
        worker_key: "sales_elite",
        title: `Closing push: ${lead.full_name}`,
        reason: priority.reason,
      },
    };
  }

  if (opp.missing.length > 0) {
    const objective = `Complete qualification for ${lead.full_name}`;
    return {
      ...base,
      objective,
      reason: `Qualification data is incomplete (${opp.missing.join(", ")}).`,
      recommendedAction: "Collect the missing qualification details",
      worker: "AI Lead Intelligence",
      workerReason:
        "Qualification completeness and scoring is the Lead Intelligence worker's domain.",
      expectedOutcome: "Missing fields are captured so a reliable decision can be made.",
      boundary: "human_approval",
      decisionConfidence: confidenceFor(opp, 70),
      tool: "executive_request_approval",
      toolInput: {
        lead_id: lead.id,
        objective,
        worker_key: "lead_intel",
        title: `Qualify: ${lead.full_name}`,
        reason: `Missing: ${opp.missing.join(", ")}.`,
      },
    };
  }

  return {
    ...base,
    objective: `Keep nurturing ${lead.full_name}`,
    reason: priority.reason,
    recommendedAction: "No action this cycle",
    worker: "AI WhatsApp Executive",
    workerReason: "Ongoing nurture stays with the conversational worker.",
    expectedOutcome: "The lead replies on its own and re-enters the priority queue.",
    boundary: "autonomous",
    decisionConfidence: confidenceFor(opp, 60),
    tool: null,
    toolInput: null,
    unavailableReason:
      "No governed capability adds value here — nothing was executed and nothing was claimed.",
  };
}
