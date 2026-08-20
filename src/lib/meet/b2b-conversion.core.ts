/**
 * UMRAIO® STEP 3C — B2B AGENCY CONVERSION & CLOSING ENGINE™ (pure, deterministic).
 *
 * Additive layer on top of STEP 3B (`b2b-executive.core`). It adds:
 *   - an evidence-based B2B conversion state machine,
 *   - agency buying-psychology signal recognition (confidence + evidence +
 *     recommended response strategy),
 *   - a commercial intent ladder,
 *   - a personalised value bridge (YOU TOLD ME → GAP → WHAT UMRAIO CAN DO →
 *     HOW IT EXECUTES → EXPECTED OUTCOME),
 *   - a personalised demonstration plan,
 *   - conversion instructions appended to the existing Meet prompt.
 *
 * It reuses — never rebuilds — hardening.core, behavioral.core,
 * conversation-intelligence.core and b2b-executive.core. No model call, no
 * database, no network. No business figure is ever invented: every claim is
 * derived only from what the agency actually stated.
 */

import { maskNegatedSpans, normalizeMessage } from "@/lib/sales/hardening.core";

import {
  B2B_OBJECTION_PLAYBOOK,
  type DemoPath,
  type MeetIntelligence,
} from "@/lib/meet/b2b-executive.core";
import type { DemoMessage } from "@/lib/meet-executive.core";

/* ------------------------------------------------------------------ *
 * §3 — B2B conversion state machine
 * ------------------------------------------------------------------ */

export type ConversionState =
  | "AWARENESS"
  | "DISCOVERY"
  | "DIAGNOSIS"
  | "PAIN_RECOGNISED"
  | "VALUE_ALIGNMENT"
  | "DEMONSTRATION"
  | "COMMERCIAL_INTEREST"
  | "OBJECTION"
  | "DECISION"
  | "TRIAL_READY"
  | "SUBSCRIPTION_READY"
  | "HUMAN_HANDOFF";

export const CONVERSION_STATE_LABEL: Record<ConversionState, string> = {
  AWARENESS: "Awareness",
  DISCOVERY: "Discovery",
  DIAGNOSIS: "Diagnosis",
  PAIN_RECOGNISED: "Pain recognised",
  VALUE_ALIGNMENT: "Value alignment",
  DEMONSTRATION: "Demonstration",
  COMMERCIAL_INTEREST: "Commercial interest",
  OBJECTION: "Objection",
  DECISION: "Decision",
  TRIAL_READY: "Trial ready",
  SUBSCRIPTION_READY: "Subscription ready",
  HUMAN_HANDOFF: "Human handoff",
};

const STATE_DIRECTIVE: Record<ConversionState, string> = {
  AWARENESS:
    "The agency has shared almost nothing. Open with one grounded question about how enquiries reach them today. Do not pitch.",
  DISCOVERY:
    "Keep learning. Ask exactly ONE question that materially improves the diagnosis. Never re-ask anything already known and never send a questionnaire.",
  DIAGNOSIS:
    "Enough is known to reason. Reflect the workflow back accurately and name only the gap the evidence supports.",
  PAIN_RECOGNISED:
    "A real problem is on the table. Translate it into a business consequence in plain language — no numbers, no ROI, no fear.",
  VALUE_ALIGNMENT:
    "Bridge from their stated situation to what UMRAIO can actually take over. Use the value bridge structure; never promise outcomes.",
  DEMONSTRATION:
    "Demonstrate on their own scenario rather than describing features. Answer the question 'how would this help MY agency'.",
  COMMERCIAL_INTEREST:
    "They are evaluating commercially. Be precise and factual, never invent pricing, and propose the lowest-risk next step.",
  OBJECTION:
    "Handle the active objection: ACKNOWLEDGE → CLARIFY → ADDRESS → PROVE → NEXT SMALL STEP. Never argue, never discount, never pressure.",
  DECISION:
    "They are deciding or must consult someone. Give a short forwardable summary, agree a check-back, and stop selling.",
  TRIAL_READY:
    "Move them to Choose a Plan on this page. Stop selling, confirm what happens next.",
  SUBSCRIPTION_READY:
    "Direct them to Choose a Plan or Talk to our team so a specialist confirms the plan. Never invent pricing or discounts.",
  HUMAN_HANDOFF:
    "Stop autonomous selling. Confirm a specialist will continue and ask nothing further about their business.",
};

/* ------------------------------------------------------------------ *
 * §11 — Commercial intent ladder
 * ------------------------------------------------------------------ */

export type CommercialIntent =
  | "NONE"
  | "CURIOUS"
  | "INTERESTED"
  | "EVALUATING"
  | "COMMERCIAL_INTENT"
  | "TRIAL_READY"
  | "SUBSCRIPTION_READY";

const PRICE_QUESTION =
  /\b(berapa\s+(harga|kos|bayar\w*|sebulan|setahun)|harga\s+(berapa|dia)|how\s+much|what('?s| is)\s+the\s+(price|cost)|pricing|price\s+list|monthly\s+(fee|cost)|yuran)\b/i;
const TRIAL_QUESTION =
  /\b(free\s+trial|trial|percubaan|boleh\s+cuba|nak\s+cuba|can\s+i\s+try|try\s+first|trial\s+dulu)\b/i;
const SUBSCRIBE_QUESTION =
  /\b(subscribe|subscription|langgan|sign\s*up|daftar|nak\s+start|boleh\s+start\s+bila|when\s+can\s+(i|we)\s+start|how\s+do\s+i\s+subscribe|nak\s+ambil)\b/i;
const EVALUATION_QUESTION =
  /\b(worth\s+it|berbaloi|compare|banding|competitor|pesaing|team\s+saya\s+boleh\s+guna|can\s+my\s+team\s+use|berapa\s+lama\s+nak\s+setup|implementation|integrate|integrasi|contract|kontrak)\b/i;
const INTEREST_QUESTION =
  /\b(boleh\s+explain|explain\s+more|macam\s?mana\s+(system|sistem)|how\s+does\s+(it|this)\s+work|tell\s+me\s+more|nak\s+tahu\s+lebih|apa\s+benda\s+ni)\b/i;

export function detectCommercialIntent(visitorMessages: string[]): {
  level: CommercialIntent;
  evidence: string | null;
} {
  const joined = maskNegatedSpans(normalizeMessage(visitorMessages.join("\n")));
  const hit = (re: RegExp) => {
    const m = re.exec(joined);
    return m ? m[0].trim().slice(0, 80) : null;
  };

  const subscribe = hit(SUBSCRIBE_QUESTION);
  if (subscribe) return { level: "SUBSCRIPTION_READY", evidence: subscribe };
  const trial = hit(TRIAL_QUESTION);
  if (trial) return { level: "TRIAL_READY", evidence: trial };
  const price = hit(PRICE_QUESTION);
  if (price) return { level: "COMMERCIAL_INTENT", evidence: price };
  const evaluating = hit(EVALUATION_QUESTION);
  if (evaluating) return { level: "EVALUATING", evidence: evaluating };
  const interested = hit(INTEREST_QUESTION);
  if (interested) return { level: "INTERESTED", evidence: interested };
  if (visitorMessages.length > 0) return { level: "CURIOUS", evidence: null };
  return { level: "NONE", evidence: null };
}

/* ------------------------------------------------------------------ *
 * §4 — Agency buying psychology
 * ------------------------------------------------------------------ */

export type AgencyPsychKey =
  | "CURIOSITY"
  | "SCEPTICISM"
  | "URGENCY"
  | "TRUST_SEEKING"
  | "PRICE_SENSITIVITY"
  | "COMPARISON"
  | "DECISION_MAKER"
  | "RISK_SENSITIVITY"
  | "TECHNOLOGY_RESISTANCE"
  | "FEAR_AI_REPLACES_STAFF"
  | "FEAR_IMPLEMENTATION_COMPLEXITY"
  | "FEAR_WHATSAPP_DISRUPTION"
  | "FEAR_LOSING_RELATIONSHIPS"
  | "DESIRE_MORE_SALES"
  | "DESIRE_FASTER_RESPONSE"
  | "DESIRE_REDUCE_WORKLOAD"
  | "DESIRE_24_7"
  | "DESIRE_PREDICTABLE_FOLLOWUP"
  | "DESIRE_COMPETITIVE_ADVANTAGE"
  | "DESIRE_MODERNISE";

export type AgencyPsychSignal = {
  key: AgencyPsychKey;
  label: string;
  confidence: number;
  evidence: string;
  strategy: string;
};

type PsychRule = {
  key: AgencyPsychKey;
  label: string;
  re: RegExp;
  strategy: string;
};

const PSYCH_RULES: PsychRule[] = [
  {
    key: "CURIOSITY",
    label: "Curiosity",
    re: /\b(macam\s?mana\s+(ia|ni|system|sistem)|how\s+does\s+(it|this)\s+work|apa\s+(itu|ni)\s+umraio|tell\s+me\s+more|nak\s+tahu|explain)\b/i,
    strategy: "Answer plainly, then convert curiosity into discovery with ONE grounded question.",
  },
  {
    key: "SCEPTICISM",
    label: "Scepticism",
    re: /\b(betul\s+ke|yakin\s+ke|tak\s+percaya|doubt|really\s+work|boleh\s+ke|prove|buktikan|susah\s+nak\s+percaya)\b/i,
    strategy:
      "Do not become defensive. Offer a demonstration on their own scenario instead of claims, and be explicit about what UMRAIO does not do.",
  },
  {
    key: "URGENCY",
    label: "Urgency",
    re: /\b(urgent|segera|cepat|asap|sekarang|this\s+month|bulan\s+ni|musim\s+umrah|peak\s+season|dah\s+tak\s+larat)\b/i,
    strategy: "Match their pace: shorten discovery and move to the lowest-friction next step.",
  },
  {
    key: "TRUST_SEEKING",
    label: "Trust seeking",
    re: /\b(siapa\s+guna|other\s+agenc\w+|reference|rujukan|company\s+mana|who('?s| is)\s+behind|legit|boleh\s+dipercayai|track\s+record)\b/i,
    strategy:
      "Be transparent about how UMRAIO works, its governance and its limits. Never invent clients, testimonials or results.",
  },
  {
    key: "PRICE_SENSITIVITY",
    label: "Price sensitivity",
    re: /\b(mahal|expensive|budget|kos|murah|discount|diskaun|tak\s+mampu|afford|berbaloi|worth\s+it)\b/i,
    strategy:
      "Never discount first. Clarify whether the concern is monthly commitment or unclear scope, then address that specific one.",
  },
  {
    key: "COMPARISON",
    label: "Comparison behaviour",
    // STEP 3E — "why should I use UMRAIO instead of another AI tool" is comparison behaviour.
    re: /\b(compare|banding|berbanding|beza\s+dengan|difference\s+with|versus|vs\b|competitor|pesaing|chatgpt|chatbot\s+lain|manychat|instead\s+of|(another|other)\s+ai|ai\s+(tool\s+)?lain|tool\s+lain)\b/i,
    strategy:
      "Compare on workflow ownership, not on features. Never disparage other tools; state factually what UMRAIO executes.",
  },
  {
    key: "DECISION_MAKER",
    label: "Decision-maker status",
    re: /\b(saya\s+(owner|pemilik|boss|founder|director)|i\s+(am|'m)\s+the\s+(owner|founder|director)|bincang\s+dengan\s+(partner|boss|rakan)|kena\s+tanya\s+(boss|partner)|discuss\s+with\s+(my\s+)?(partner|boss|team))\b/i,
    strategy:
      "Identify who decides. If someone else must approve, prepare a short forwardable summary rather than pushing for a decision now.",
  },
  {
    key: "RISK_SENSITIVITY",
    label: "Risk sensitivity",
    re: /\b(risiko|risk|kalau\s+(salah|gagal|rosak)|what\s+if\s+(it\s+)?(fails|goes\s+wrong)|takut\s+(rugi|masalah)|contract|lock[\s-]?in|commitment)\b/i,
    strategy:
      "Reduce perceived risk: explain human takeover, opt-out enforcement and the ability to start on a single workflow.",
  },
  {
    key: "TECHNOLOGY_RESISTANCE",
    label: "Technology resistance",
    re: /\b(tak\s+pandai\s+(tech|komputer|it)|not\s+technical|susah\s+nak\s+belajar|staff\s+saya\s+tak\s+biasa|too\s+technical|complicated)\b/i,
    strategy:
      "Emphasise that the workflow stays on WhatsApp and the team keeps working the way they already do.",
  },
  {
    key: "FEAR_AI_REPLACES_STAFF",
    label: "Fear AI replaces staff",
    re: /\b(replace\s+(my\s+)?(staff|team|worker)|ganti\s+(staff|pekerja|team)|staff\s+saya\s+hilang\s+kerja|buang\s+staff|lay\s?off)\b/i,
    strategy:
      "Be clear that UMRAIO is capacity, not replacement: it handles first response, qualification and follow-up so consultants close.",
  },
  {
    key: "FEAR_IMPLEMENTATION_COMPLEXITY",
    label: "Fear of implementation complexity",
    re: /\b(susah\s+(nak\s+)?(setup|pasang|start)|hard\s+to\s+(setup|implement)|berapa\s+lama\s+(nak\s+)?setup|migrat\w+|training\s+staff|onboarding\s+susah)\b/i,
    strategy: "Describe the smallest possible starting scope — one workflow, existing WhatsApp number, no rebuild.",
  },
  {
    key: "FEAR_WHATSAPP_DISRUPTION",
    label: "Fear of WhatsApp disruption",
    re: /\b(nombor\s+whatsapp\s+(saya|kami)|whatsapp\s+(kena\s+ban|banned|block)|akaun\s+kena\s+block|existing\s+whatsapp|tukar\s+nombor)\b/i,
    strategy:
      "Address the channel concern factually: official WhatsApp Business API usage and human takeover remain intact.",
  },
  {
    key: "FEAR_LOSING_RELATIONSHIPS",
    label: "Fear of losing customer relationships",
    re: /\b(hubungan\s+(dengan\s+)?customer|personal\s+touch|customer\s+kenal\s+saya|jemaah\s+percaya\s+kami|relationship\s+with\s+(my\s+)?customer|tak\s+nak\s+jadi\s+robotik)\b/i,
    strategy:
      "Confirm the relationship stays with them: UMRAIO prepares and hands over, and any customer can reach a human immediately.",
  },
  {
    key: "DESIRE_MORE_SALES",
    label: "Desire for more sales",
    re: /\b(nak\s+(tambah|naikkan)\s+(sales|jualan|booking)|more\s+(sales|bookings)|increase\s+sales|sales\s+(saya\s+|kami\s+)?(drop|turun|merundum|slow|lembab)|tak\s+jadi\s+booking)\b/i,
    strategy: "Diagnose where the leak actually is before recommending anything. Never promise sales increases.",
  },
  {
    key: "DESIRE_FASTER_RESPONSE",
    label: "Desire for faster response",
    re: /\b(reply\s+(cepat|laju|fast)|respond\s+faster|balas\s+cepat|instant\s+reply|jawab\s+segera|lambat\s+reply)\b/i,
    strategy: "Point to the AI WhatsApp Executive and demonstrate a real first response.",
  },
  {
    key: "DESIRE_REDUCE_WORKLOAD",
    label: "Desire to reduce workload",
    re: /\b(kurangkan\s+(kerja|beban)|reduce\s+(workload|manpower)|staff\s+(penat|overload|tak\s+larat)|too\s+much\s+work|banyak\s+sangat\s+kerja|manual\s+semua)\b/i,
    strategy: "Focus on the repetitive steps they described and show which of those UMRAIO can take over.",
  },
  {
    key: "DESIRE_24_7",
    label: "Desire for 24/7 coverage",
    re: /\b(24\s*\/?\s*7|24\s*jam|round\s+the\s+clock|malam\s+pun|after\s+hours?|weekend\s+pun|cuti\s+pun)\b/i,
    strategy: "Show after-hours handling with escalation to a human on the next working morning.",
  },
  {
    key: "DESIRE_PREDICTABLE_FOLLOWUP",
    label: "Desire for predictable follow-up",
    re: /\b(follow[\s-]?up\s+(konsisten|automatik|teratur)|consistent\s+follow[\s-]?up|jangan\s+terlepas|never\s+miss|reminder\s+automatik)\b/i,
    strategy: "Demonstrate scheduled, context-aware follow-up that respects opt-out.",
  },
  {
    key: "DESIRE_COMPETITIVE_ADVANTAGE",
    label: "Desire for competitive advantage",
    re: /\b(pesaing|competitor|agensi\s+lain|other\s+agencies|nak\s+lebih\s+(pantas|maju)|stay\s+ahead|advantage)\b/i,
    strategy: "Keep it factual: describe capability, never claim superiority over named competitors.",
  },
  {
    key: "DESIRE_MODERNISE",
    label: "Desire to modernise",
    re: /\b(modenkan|modernise|modernize|upgrade\s+(sistem|system)|digital|automate\s+(our|my)\s+(business|agency)|transform)\b/i,
    strategy: "Anchor modernisation to one concrete workflow rather than an abstract transformation.",
  },
];

export function detectAgencyPsychology(visitorMessages: string[]): AgencyPsychSignal[] {
  const normalised = visitorMessages.map((m) => normalizeMessage(m));
  const masked = normalised.map((m) => maskNegatedSpans(m));
  const out: AgencyPsychSignal[] = [];

  for (const rule of PSYCH_RULES) {
    let hits = 0;
    let ev = "";
    let recent = false;
    for (let i = 0; i < masked.length; i += 1) {
      const m = rule.re.exec(masked[i]!);
      if (!m) continue;
      hits += 1;
      ev = m[0].trim().slice(0, 80);
      if (i >= masked.length - 2) recent = true;
    }
    if (!hits) continue;
    const confidence = Math.min(0.95, 0.55 + (hits - 1) * 0.15 + (recent ? 0.1 : 0));
    out.push({
      key: rule.key,
      label: rule.label,
      confidence: Number(confidence.toFixed(2)),
      evidence: ev,
      strategy: rule.strategy,
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

/* ------------------------------------------------------------------ *
 * §10 — Value bridge
 * ------------------------------------------------------------------ */

export type ValueBridge = {
  youToldMe: string;
  businessGap: string;
  whatUmraioCanDo: string;
  howItExecutes: string;
  expectedOutcome: string;
};

const CAPABILITY_ACTION: Record<string, { can: string; how: string; outcome: string }> = {
  response: {
    can: "answer every inbound WhatsApp enquiry immediately, in the customer's own language",
    how: "the AI WhatsApp Executive receives the message, replies, captures the enquiry into the CRM and flags anything that needs a human",
    outcome: "enquiries stop waiting for a consultant to become free before they receive a first reply",
  },
  after_hours: {
    can: "keep answering enquiries that arrive at night, on weekends and on rest days",
    how: "the AI WhatsApp Executive handles the conversation and escalates to your team on the next working session",
    outcome: "after-hours enquiries are engaged instead of being read the following day",
  },
  followup: {
    can: "run follow-up as a scheduled process instead of something people must remember",
    how: "the AI Autonomous Business Executive™ schedules the follow-up, keeps the context of the last real conversation and stops instantly on opt-out",
    outcome: "interested customers stop disappearing simply because nobody returned to them at the right time",
  },
  qualification: {
    can: "collect the qualification details conversationally, before a consultant joins",
    how: "the AI WhatsApp Executive asks for pax, month, budget and preferences naturally and records them on the lead",
    outcome: "consultants spend their time on prospects that are already qualified",
  },
  prioritisation: {
    can: "rank which enquiries deserve attention first",
    how: "AI Lead Intelligence scores each lead from real conversation signals and surfaces the highest-intent ones",
    outcome: "ready-to-book enquiries are no longer handled at the same pace as casual ones",
  },
  quotation: {
    can: "prepare the quotation as soon as the requirements are known",
    how: "the quotation is generated from your own verified package data and sent for the customer to review",
    outcome: "the customer can decide sooner, because the offer arrives while they are still engaged",
  },
  manual_work: {
    can: "take over the repetitive parts of the workflow you described",
    how: "the AI Autonomous Business Executive™ coordinates the specialist workers under your governance settings",
    outcome: "the same team can handle more enquiries without dropping the quality of each one",
  },
  automation: {
    can: "put a repeatable process around enquiry handling",
    how: "the AI Autonomous Business Executive™ prioritises and coordinates each next action across the workforce",
    outcome: "the workflow no longer stops whenever a specific person is unavailable",
  },
  capacity: {
    can: "absorb enquiry volume that currently depends on individual effort",
    how: "the AI WhatsApp Executive handles first contact and qualification in parallel across every conversation",
    outcome: "volume peaks are handled consistently rather than by working longer hours",
  },
  experience: {
    can: "give every customer a fast, consistent first experience",
    how: "the AI WhatsApp Executive replies immediately and hands over to a human whenever the customer asks",
    outcome: "the experience stays consistent even when the team is busy",
  },
};

export function buildValueBridge(intel: MeetIntelligence): ValueBridge | null {
  const gap = intel.detectedGaps[0];
  if (!gap) return null;
  const action = CAPABILITY_ACTION[gap.key];
  if (!action) return null;

  return {
    youToldMe: gap.evidence
      ? `You told me: "${gap.evidence}".`
      : `You described a situation around ${gap.label.toLowerCase()}.`,
    businessGap: gap.detail,
    whatUmraioCanDo: `Based on what you shared, UMRAIO can ${action.can}.`,
    howItExecutes: `How it executes: ${action.how}.`,
    expectedOutcome: `Expected effect: ${action.outcome}. This is a designed capability, not a guaranteed result.`,
  };
}

/* ------------------------------------------------------------------ *
 * §9 — Personalised demonstration plan
 * ------------------------------------------------------------------ */

export type DemonstrationPlan = {
  path: DemoPath;
  headline: string;
  answers: string;
};

const DEMO_HEADLINE: Record<DemoPath, string> = {
  WHATSAPP_LEAD_HANDLING: "AI WhatsApp Executive on a real inbound enquiry",
  LEAD_QUALIFICATION: "Conversational lead qualification",
  PACKAGE_RECOMMENDATION: "Package recommendation from stated requirements",
  OBJECTION_HANDLING: "Customer objection handled without pressure",
  QUOTATION_GENERATION: "Quotation prepared from your own package data",
  FOLLOW_UP: "Scheduled, context-aware follow-up",
  BUYING_SIGNAL_DETECTION: "Buying-signal detection and escalation",
  HUMAN_HANDOFF: "Human takeover stopping automated messaging",
  SALES_INTELLIGENCE: "Lead scoring and prioritisation",
  BUSINESS_ORCHESTRATION: "AI Autonomous Business Executive™ orchestration",
};

export function buildDemonstrationPlan(intel: MeetIntelligence): DemonstrationPlan | null {
  const path = intel.demoPath;
  if (!path) return null;
  return {
    path,
    headline: DEMO_HEADLINE[path],
    answers:
      "Answer the question 'how would this help MY agency', using only the workflow this agency described — never a generic feature tour.",
  };
}

/* ------------------------------------------------------------------ *
 * Aggregate conversion read
 * ------------------------------------------------------------------ */

export type ConversionRead = {
  state: ConversionState;
  stateLabel: string;
  commercialIntent: CommercialIntent;
  commercialEvidence: string | null;
  psychology: AgencyPsychSignal[];
  valueBridge: ValueBridge | null;
  demonstration: DemonstrationPlan | null;
  activeObjections: string[];
  blocked: boolean;
};

export function analyzeConversion(
  intel: MeetIntelligence,
  messages: DemoMessage[],
): ConversionRead {
  const visitor = messages.filter((m) => m.role === "visitor").map((m) => m.content);
  const intent = detectCommercialIntent(visitor);
  const psychology = detectAgencyPsychology(visitor);
  const activeObjections = intel.objections.filter((o) => o.status === "ACTIVE").map((o) => o.category);
  const valueBridge = buildValueBridge(intel);
  const demonstration = buildDemonstrationPlan(intel);

  let state: ConversionState;
  if (intel.optedOut || intel.humanRequested) state = "HUMAN_HANDOFF";
  else if (intent.level === "SUBSCRIPTION_READY") state = "SUBSCRIPTION_READY";
  else if (intent.level === "TRIAL_READY") state = "TRIAL_READY";
  else if (activeObjections.length) state = "OBJECTION";
  else if (activeObjections.length === 0 && intel.objections.length && intent.level === "EVALUATING")
    state = "DECISION";
  else if (intent.level === "COMMERCIAL_INTENT" || intent.level === "EVALUATING")
    state = "COMMERCIAL_INTEREST";
  else if (intel.nextBestAction === "RUN_DEMONSTRATION" || intel.simulationRequested)
    state = "DEMONSTRATION";
  else if (intel.diagnosis && valueBridge) state = "VALUE_ALIGNMENT";
  else if (intel.diagnosis) state = "DIAGNOSIS";
  else if (intel.detectedGaps.length) state = "PAIN_RECOGNISED";
  else if (visitor.length >= 1) state = "DISCOVERY";
  else state = "AWARENESS";

  return {
    state,
    stateLabel: CONVERSION_STATE_LABEL[state],
    commercialIntent: intent.level,
    commercialEvidence: intent.evidence,
    psychology,
    valueBridge,
    demonstration,
    activeObjections,
    blocked: intel.optedOut || intel.humanRequested,
  };
}

/* ------------------------------------------------------------------ *
 * Prompt instruction (appended to the existing Meet instruction)
 * ------------------------------------------------------------------ */

export function conversionInstruction(conv: ConversionRead): string {
  const lines: string[] = [
    "UMRAIO B2B CONVERSION ENGINE™ — deterministic conversion read. Context only, never text to repeat.",
    `Conversion state: ${conv.state} — ${STATE_DIRECTIVE[conv.state]}`,
    `Commercial intent: ${conv.commercialIntent}${conv.commercialEvidence ? ` (evidence: "${conv.commercialEvidence}")` : ""}. Never treat curiosity as commitment and never force the state forward.`,
  ];

  if (conv.psychology.length) {
    lines.push(
      `Buying psychology detected: ${conv.psychology
        .slice(0, 4)
        .map((p) => `${p.key} (confidence ${p.confidence}, evidence: "${p.evidence}") → ${p.strategy}`)
        .join(" | ")}`,
    );
  } else {
    lines.push("No buying-psychology signal is evidenced yet. Do not assume motivation or fear.");
  }

  if (conv.activeObjections.length) {
    lines.push(
      `Objection handling required: ${conv.activeObjections
        .map((c) => `${c} → ${B2B_OBJECTION_PLAYBOOK[c as keyof typeof B2B_OBJECTION_PLAYBOOK]}`)
        .join(" | ")}`,
    );
  }

  if (conv.valueBridge) {
    const v = conv.valueBridge;
    lines.push(
      `Value bridge to use, in this order and in the visitor's language: ${v.youToldMe} ${v.businessGap} ${v.whatUmraioCanDo} ${v.howItExecutes} ${v.expectedOutcome}`,
    );
  } else {
    lines.push("No value bridge yet — nothing has been evidenced. Keep diagnosing instead of pitching.");
  }

  if (conv.demonstration)
    lines.push(
      `Personalised demonstration: ${conv.demonstration.path} — ${conv.demonstration.headline}. ${conv.demonstration.answers}`,
    );

  lines.push(
    "STYLE: sound like a senior business executive, not a chatbot. Never open with 'Thank you for your interest', 'How can I assist you today', 'Our solution provides' or 'Would you like to know more'. Be calm, concise, empathetic and specific to what they said.",
    "PRICE: never discount first and never invent a figure. If price is raised, clarify whether the concern is the monthly commitment or unclear scope, then address that one.",
    "NEVER manipulate, exploit fear, create artificial urgency, fabricate scarcity, invent testimonials, clients, ROI or agency numbers, or pressure a hesitant owner. If information is unavailable, ask for it explicitly.",
  );

  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Conversion events (derived, additive to STEP 3B events)
 * ------------------------------------------------------------------ */

export type ConversionEvent =
  | "conversion_state_changed"
  | "psychology_signal_detected"
  | "value_bridge_presented"
  | "personalised_demo_selected"
  | "commercial_intent_detected"
  | "objection_active"
  | "decision_stage_reached"
  | "trial_ready"
  | "subscription_ready"
  | "conversion_blocked";

export function deriveConversionEvents(conv: ConversionRead): ConversionEvent[] {
  const out: ConversionEvent[] = ["conversion_state_changed"];
  if (conv.psychology.length) out.push("psychology_signal_detected");
  if (conv.valueBridge) out.push("value_bridge_presented");
  if (conv.demonstration) out.push("personalised_demo_selected");
  if (
    conv.commercialIntent === "COMMERCIAL_INTENT" ||
    conv.commercialIntent === "TRIAL_READY" ||
    conv.commercialIntent === "SUBSCRIPTION_READY"
  )
    out.push("commercial_intent_detected");
  if (conv.activeObjections.length) out.push("objection_active");
  if (conv.state === "DECISION") out.push("decision_stage_reached");
  if (conv.state === "TRIAL_READY") out.push("trial_ready");
  if (conv.state === "SUBSCRIPTION_READY") out.push("subscription_ready");
  if (conv.blocked) out.push("conversion_blocked");
  return Array.from(new Set(out));
}

/** Short, forwardable summary for a decision-maker (§ decision support). */
export function buildConversionBrief(intel: MeetIntelligence, conv: ConversionRead): string {
  const lines = [
    "UMRAIO CONVERSION READ",
    `Conversion state: ${conv.state}`,
    `Commercial intent: ${conv.commercialIntent}`,
    `Funnel stage (3B): ${intel.stage}`,
    `Active objections: ${conv.activeObjections.length ? conv.activeObjections.join(", ") : "None"}`,
    `Psychology: ${conv.psychology.length ? conv.psychology.slice(0, 4).map((p) => `${p.key} ${p.confidence}`).join(", ") : "None evidenced"}`,
  ];
  if (conv.valueBridge) {
    lines.push(
      "",
      "VALUE BRIDGE",
      conv.valueBridge.youToldMe,
      conv.valueBridge.businessGap,
      conv.valueBridge.whatUmraioCanDo,
      conv.valueBridge.howItExecutes,
      conv.valueBridge.expectedOutcome,
    );
  }
  if (conv.demonstration) lines.push("", "DEMONSTRATION", conv.demonstration.headline);
  return lines.join("\n");
}
