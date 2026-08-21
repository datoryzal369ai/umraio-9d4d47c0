/**
 * UMRAIO® — EXECUTIVE INSIGHT evidence classification (pure derivation).
 *
 * Every insight must classify its reasoning:
 *   FACT            — directly supported by persisted application data
 *   SIGNAL          — a meaningful pattern detected from available data
 *   INTERPRETATION  — the Executive's reasoned understanding of the signal
 *   RECOMMENDATION  — the action the Executive recommends
 *
 * When evidence is insufficient we say INSUFFICIENT DATA and name what is
 * missing. We never invent probability, intent, value or historical
 * performance to fill a gap.
 */
import type { Lead } from "@/lib/leads";
import type { EngineTask } from "@/lib/tasks";
import type { OutcomeFinding } from "@/lib/executive/outcome.core";

export type EvidenceKind = "fact" | "signal" | "interpretation" | "recommendation";

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  fact: "FACT",
  signal: "SIGNAL",
  interpretation: "INTERPRETATION",
  recommendation: "RECOMMENDATION",
};

export const EVIDENCE_TONE: Record<EvidenceKind, string> = {
  fact: "bg-success/12 text-success",
  signal: "bg-primary/15 text-primary",
  interpretation: "bg-electric/12 text-electric",
  recommendation: "bg-gold/15 text-gold-bright",
};

export type ExecutiveInsight = {
  id: string;
  title: string;
  /** Populated when evidence supports a conclusion. */
  evidence: { kind: EvidenceKind; text: string }[];
  /** Populated instead of `evidence` when the data is not sufficient. */
  insufficient: { reason: string; missing: string[] } | null;
  /** Confidence is only shown when the underlying data supports it. */
  confidence: "low" | "medium" | "high" | null;
  link: { to: "/leads" | "/tasks" | "/executive/audit"; label: string } | null;
};

const DAY = 24 * 60 * 60 * 1000;

const hoursSince = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);

const isStale = (lead: Lead) =>
  !lead.last_contact_at || Date.now() - new Date(lead.last_contact_at).getTime() > DAY;

function leadRef(lead: Lead) {
  return `${lead.full_name} (#${lead.id.slice(0, 8).toUpperCase()})`;
}

/**
 * Builds the evidence-classified insight set from REAL records only.
 * Passing empty arrays yields honest INSUFFICIENT DATA insights.
 */
export function buildExecutiveInsights(input: {
  leads: Lead[];
  tasks: EngineTask[];
  findings: OutcomeFinding[];
}): ExecutiveInsight[] {
  const { leads, tasks, findings } = input;
  const insights: ExecutiveInsight[] = [];

  const openLeads = leads.filter((l) => !["completed", "lost"].includes(l.stage));
  const highIntent = openLeads.filter((l) => l.temperature === "hot" || l.score >= 70);

  /* ---------- 1. Pipeline opportunity ---------- */
  if (leads.length === 0) {
    insights.push({
      id: "pipeline",
      title: "Pipeline opportunity",
      evidence: [],
      insufficient: {
        reason: "Commercial opportunity cannot be assessed because no leads exist yet.",
        missing: ["Lead records", "Customer engagement history"],
      },
      confidence: null,
      link: { to: "/leads", label: "Open leads" },
    });
  } else {
    const stalled = [...highIntent]
      .filter(isStale)
      .sort((a, b) => b.score - a.score)[0];

    if (stalled) {
      const contactFact = stalled.last_contact_at
        ? `Last recorded contact was ${hoursSince(stalled.last_contact_at)}h ago.`
        : "No customer contact has ever been recorded for this lead.";
      insights.push({
        id: `pipeline-${stalled.id}`,
        title: "Pipeline opportunity",
        evidence: [
          {
            kind: "fact",
            text: `Lead ${leadRef(stalled)} is in the ${stalled.stage} stage with a score of ${stalled.score} and temperature ${stalled.temperature}. ${contactFact}`,
          },
          {
            kind: "signal",
            text: `${highIntent.length} of ${openLeads.length} open leads show high intent, and this one has had no engagement for over 24 hours.`,
          },
          {
            kind: "interpretation",
            text: "The opportunity appears commercially active but stalled before the decision stage.",
          },
          {
            kind: "recommendation",
            text: "A personalised follow-up focused on the remaining booking barrier should be prepared by the responsible specialist worker.",
          },
        ],
        insufficient: null,
        // Confidence is derived from the completeness of the record, not invented.
        confidence: stalled.last_contact_at && stalled.score > 0 ? "medium" : "low",
        link: { to: "/leads", label: "Open leads" },
      });
    } else if (highIntent.length === 0) {
      insights.push({
        id: "pipeline-none",
        title: "Pipeline opportunity",
        evidence: [
          {
            kind: "fact",
            text: `${openLeads.length} open leads exist and none currently meets the high-intent threshold (hot, or score 70+).`,
          },
          {
            kind: "signal",
            text: "No measurable buying-intent pattern is present in the current pipeline.",
          },
          {
            kind: "interpretation",
            text: "There is no commercially urgent opportunity to act on right now.",
          },
          { kind: "recommendation", text: "Continue nurture; no executive intervention required." },
        ],
        insufficient: null,
        confidence: "high",
        link: { to: "/leads", label: "Open leads" },
      });
    } else {
      insights.push({
        id: "pipeline-engaged",
        title: "Pipeline opportunity",
        evidence: [
          {
            kind: "fact",
            text: `${highIntent.length} high-intent leads are open and every one has been contacted within the last 24 hours.`,
          },
          { kind: "signal", text: "Engagement cadence is being maintained across the hot pipeline." },
          {
            kind: "interpretation",
            text: "The pipeline is being worked; the constraint is conversion quality, not contact frequency.",
          },
          {
            kind: "recommendation",
            text: "Hold cadence and wait for measurable customer responses before adding further contact.",
          },
        ],
        insufficient: null,
        confidence: "medium",
        link: { to: "/leads", label: "Open leads" },
      });
    }
  }

  /* ---------- 2. Governance / approval backlog ---------- */
  const awaiting = tasks.filter((t) => t.status === "waiting_approval");
  const oldest = [...awaiting].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )[0];
  if (awaiting.length > 0 && oldest) {
    insights.push({
      id: "governance",
      title: "Governance backlog",
      evidence: [
        {
          kind: "fact",
          text: `${awaiting.length} executive action${awaiting.length === 1 ? "" : "s"} are recorded as WAITING_APPROVAL; the oldest has been waiting ${hoursSince(oldest.created_at)}h.`,
        },
        {
          kind: "signal",
          text: "Governed actions are being produced faster than they are being decided.",
        },
        {
          kind: "interpretation",
          text: "Execution is blocked by governance, not by capability — nothing has been sent to a customer.",
        },
        {
          kind: "recommendation",
          text: "Review and approve or reject the pending actions so the executive loop can progress.",
        },
      ],
      insufficient: null,
      confidence: "high",
      link: { to: "/tasks", label: "Review approvals" },
    });
  }

  /* ---------- 3. Execution reliability ---------- */
  const failed = tasks.filter((t) => t.status === "failed");
  if (failed.length > 0) {
    const escalating = failed.filter((t) => t.requires_approval).length;
    insights.push({
      id: "reliability",
      title: "Execution reliability",
      evidence: [
        {
          kind: "fact",
          text: `${failed.length} task${failed.length === 1 ? "" : "s"} are recorded as FAILED, of which ${escalating} were approval-gated.`,
        },
        {
          kind: "signal",
          text: "Side effects are failing after approval rather than at decision time.",
        },
        {
          kind: "interpretation",
          text: escalating > 0
            ? "Approval-gated failures need human intervention; a retry alone is not appropriate."
            : "Failures are within autonomous scope and may be safely re-attempted.",
        },
        {
          kind: "recommendation",
          text: escalating > 0
            ? "Escalate the failed approval-gated actions to a human operator."
            : "Inspect the failure detail in the audit log before re-running.",
        },
      ],
      insufficient: null,
      confidence: "high",
      link: { to: "/executive/audit", label: "Open audit log" },
    });
  }

  /* ---------- 4. Post-execution business outcome ---------- */
  const completedActions = tasks.filter(
    (t) => t.kind === "executive_action" && t.status === "completed",
  );
  if (completedActions.length > 0 && findings.length === 0) {
    insights.push({
      id: "outcome",
      title: "Business outcome",
      evidence: [],
      insufficient: {
        reason:
          "Business outcome cannot be reliably assessed because no executed action has been observable long enough to be measured.",
        missing: ["Post-execution customer activity", "Outcome monitor result"],
      },
      confidence: null,
      link: { to: "/executive/audit", label: "Open audit log" },
    });
  } else if (findings.length > 0) {
    const noResponse = findings.filter((f) => f.outcome === "no_response").length;
    const progressed = findings.filter((f) => f.outcome === "progressed").length;
    insights.push({
      id: "outcome",
      title: "Business outcome",
      evidence: [
        {
          kind: "fact",
          text: `${findings.length} executed executive action${findings.length === 1 ? "" : "s"} have been outcome-checked: ${progressed} PROGRESSED, ${findings.filter((f) => f.outcome === "responded").length} RESPONDED, ${noResponse} NO RESPONSE.`,
        },
        {
          kind: "signal",
          text: noResponse > 0
            ? "A share of successfully executed actions has produced no measurable business movement."
            : "Executed actions are correlating with measurable business movement.",
        },
        {
          kind: "interpretation",
          text: noResponse > 0
            ? "Execution success is not converting into business progression for every opportunity."
            : "The current action mix is producing real pipeline movement.",
        },
        {
          kind: "recommendation",
          text: noResponse > 0
            ? "Follow up through an alternative approved channel or escalate to human sales review."
            : "Maintain the current approach and keep monitoring.",
        },
      ],
      insufficient: null,
      confidence: findings.length >= 3 ? "medium" : "low",
      link: { to: "/executive/audit", label: "Open audit log" },
    });
  }

  return insights;
}
