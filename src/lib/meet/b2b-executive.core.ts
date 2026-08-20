/**
 * UMRAIO® STEP 3B — MEET YOUR UMRAIO EXECUTIVE™ (pure deterministic core).
 *
 * Additive B2B layer: the visitor here is an Umrah AGENCY, not a pilgrim.
 * It reuses — and never duplicates — the existing engines:
 *   - hardening.core        (normalisation, negation masking, opt-out,
 *                            frustration, human request)
 *   - behavioral.core       (Behavioral Sales Psychology Engine, Step 3.7)
 *   - conversation-intelligence.core (language + style detection)
 *
 * Nothing here calls a model, a database or the network. No business figure is
 * ever invented: a dimension is only filled when the agency stated it.
 */

import {
  buildBehavioralProfile,
  behavioralInstruction,
  type BehavioralProfile,
} from "@/lib/sales/behavioral.core";
import {
  detectConversationalStyle,
  detectMessageLanguage,
  resolveReplyLanguage,
  type ConversationalStyle,
  type LanguageCode,
} from "@/lib/sales/conversation-intelligence.core";
import {
  conversationOptedOut,
  detectFrustration,
  detectHumanRequest,
  maskNegatedSpans,
  normalizeMessage,
  detectObjectionResolution,
  type FrustrationSignal,
} from "@/lib/sales/hardening.core";

import type { DemoMessage } from "@/lib/meet-executive.core";

/* ------------------------------------------------------------------ *
 * Intelligent states (§4 — "Insufficient data" is no longer the default)
 * ------------------------------------------------------------------ */

export type FactStatus =
  | "NOT_PROVIDED"
  | "NOT_YET_ESTABLISHED"
  | "ASSESSING"
  | "NEEDS_MORE_INFORMATION"
  | "CONFIRMED"
  | "DETECTED"
  | "NOT_APPLICABLE";

export const FACT_STATUS_LABEL: Record<FactStatus, string> = {
  NOT_PROVIDED: "Not provided",
  NOT_YET_ESTABLISHED: "Not yet established",
  ASSESSING: "Assessing",
  NEEDS_MORE_INFORMATION: "Needs more information",
  CONFIRMED: "Confirmed",
  DETECTED: "Detected",
  NOT_APPLICABLE: "Not applicable",
};

export type SnapshotRow = {
  key: string;
  label: string;
  value: string;
  status: FactStatus;
};

/* ------------------------------------------------------------------ *
 * Pain / opportunity model (§6)
 * ------------------------------------------------------------------ */

export type B2bGapKey =
  | "response"
  | "after_hours"
  | "followup"
  | "qualification"
  | "prioritisation"
  | "quotation"
  | "manual_work"
  | "automation"
  | "capacity"
  | "experience";

export type GapStatus = "NOT_YET_ESTABLISHED" | "ASSESSING" | "DETECTED" | "COVERED";

export type B2bGap = {
  key: B2bGapKey;
  label: string;
  status: GapStatus;
  detail: string;
  consequence: string | null;
  evidence: string | null;
};

const GAP_LABEL: Record<B2bGapKey, string> = {
  response: "Response gap",
  after_hours: "After-hours gap",
  followup: "Follow-up gap",
  qualification: "Qualification gap",
  prioritisation: "Lead prioritisation gap",
  quotation: "Quotation gap",
  manual_work: "Manual work gap",
  automation: "Automation gap",
  capacity: "Sales capacity gap",
  experience: "Customer experience gap",
};

/* ------------------------------------------------------------------ *
 * B2B objection taxonomy (§10)
 * ------------------------------------------------------------------ */

export type B2bObjection =
  | "AI_SOUNDS_ROBOTIC"
  | "ALREADY_HAVE_SALES_TEAM"
  | "TEAM_CAN_DO_IT"
  | "COST"
  | "CUSTOMERS_WANT_HUMANS"
  | "NEEDS_PARTNER_APPROVAL"
  | "WANT_TO_OBSERVE_FIRST"
  | "DOUBT_AI_CAN_CLOSE"
  | "DATA_SECURITY"
  | "ALREADY_HAVE_CRM";

export const B2B_OBJECTION_PLAYBOOK: Record<B2bObjection, string> = {
  AI_SOUNDS_ROBOTIC:
    "Acknowledge the concern as valid, then offer to demonstrate instead of explaining: ask for one real customer message they usually receive and answer it the way UMRAIO would.",
  ALREADY_HAVE_SALES_TEAM:
    "Never position UMRAIO as a replacement for their team. Position it as capacity: it handles first response, qualification and follow-up so consultants spend time on closing.",
  TEAM_CAN_DO_IT:
    "Agree that the team can do it. Clarify what happens at volume, at night and on rest days, and let the consistency gap speak for itself.",
  COST: "Do not invent pricing, discounts or ROI. Move to the lowest-risk entry step and let them evaluate with their own workflow.",
  CUSTOMERS_WANT_HUMANS:
    "Agree. Explain that UMRAIO is designed to hand over to a human on request or on escalation, and that human takeover stops autonomous messaging immediately.",
  NEEDS_PARTNER_APPROVAL:
    "This is a decision process, not a rejection. Offer a short forwardable summary of what was discussed and agree a specific time to check back. No pressure.",
  WANT_TO_OBSERVE_FIRST:
    "Respect it. Offer the lowest-friction step (assessment or trial) with no obligation, and stop selling.",
  DOUBT_AI_CAN_CLOSE:
    "Do not claim guaranteed closing. Explain what is actually automated — qualification, prioritisation, quotation preparation and follow-up — and offer to demonstrate one of them.",
  DATA_SECURITY:
    "Answer factually: tenant-isolated data, access-controlled records, human takeover and opt-out enforcement. Never claim certifications the platform does not hold.",
  ALREADY_HAVE_CRM:
    "A CRM records; UMRAIO executes. Ask what still happens manually around the CRM and address that specific step.",
};

const OBJECTION_PATTERNS: Array<{ cat: B2bObjection; re: RegExp }> = [
  {
    cat: "AI_SOUNDS_ROBOTIC",
    re: /\b(macam\s+robot|like\s+a\s+robot|robotic|bunyi\s+robot|sound\s+robot|tak\s+natural|not\s+natural|kaku)\b/i,
  },
  {
    cat: "ALREADY_HAVE_SALES_TEAM",
    re: /\b(dah\s+ada\s+(sales|team|staff)|already\s+have\s+(a\s+)?(sales\s+)?team|ada\s+sales\s+team|team\s+saya\s+dah)\b/i,
  },
  {
    cat: "TEAM_CAN_DO_IT",
    re: /\b(team\s+saya\s+boleh\s+buat|boleh\s+buat\s+sendiri|we\s+can\s+do\s+(it|this)\s+(our)?self|do\s+it\s+ourselves|staff\s+saya\s+boleh)\b/i,
  },
  {
    cat: "COST",
    re: /\b(mahal|expensive|kos\s+tinggi|too\s+costly|budget\s+ketat|tak\s+mampu|cannot\s+afford|berbaloi\s+ke|worth\s+it)\b/i,
  },
  {
    cat: "CUSTOMERS_WANT_HUMANS",
    re: /\b(customer\s+(saya\s+)?(nak|mahu|prefer)\s+(manusia|human|orang)|prefer\s+(to\s+)?talk\s+to\s+(a\s+)?human|nak\s+cakap\s+dengan\s+orang)\b/i,
  },
  {
    cat: "NEEDS_PARTNER_APPROVAL",
    re: /\b(bincang\s+dengan\s+(partner|rakan|boss|bos|director)|discuss\s+with\s+(my\s+)?(partner|boss|director|team)|kena\s+tanya\s+(boss|partner)|need\s+approval)\b/i,
  },
  {
    cat: "WANT_TO_OBSERVE_FIRST",
    re: /\b(tengok\s+dulu|nak\s+tengok\s+dulu|observe\s+first|wait\s+and\s+see|see\s+first|later\s+only|fikir\s+dulu|think\s+about\s+it)\b/i,
  },
  {
    cat: "DOUBT_AI_CAN_CLOSE",
    re: /\b(ai\s+(ni\s+)?boleh\s+close|can\s+ai\s+(really\s+)?close|tak\s+yakin\s+ai|not\s+confident\s+ai|ai\s+boleh\s+ke|doubt)\b/i,
  },
  {
    cat: "DATA_SECURITY",
    // STEP 3E — "data customer saya selamat ke?" must register as a trust objection.
    re: /\b(data[^.?!]{0,25}\b(selamat|secure|safe|protected|terjamin)|customer\s+data|data\s+(customer|pelanggan)|privacy|pdpa|bocor|leak|confidential)\b/i,
  },
  {
    cat: "ALREADY_HAVE_CRM",
    re: /\b(dah\s+ada\s+(crm|sistem|system)|already\s+(have|using)\s+(a\s+)?(crm|system)|guna\s+(crm|hubspot|zoho|salesforce))\b/i,
  },
];

export type ObjectionRead = {
  category: B2bObjection;
  status: "ACTIVE" | "RESOLVED";
  evidence: string;
};

/* ------------------------------------------------------------------ *
 * Funnel / intent ladder (§11, §17)
 * ------------------------------------------------------------------ */

export type B2bStage =
  | "LOW_INTENT"
  | "CURIOUS"
  | "PROBLEM_AWARE"
  | "SOLUTION_AWARE"
  | "DEMO_READY"
  | "HIGH_INTENT"
  | "TRIAL_READY"
  | "SUBSCRIPTION_READY"
  | "HUMAN_HANDOFF"
  | "DO_NOT_CONTACT";

export type B2bNextBestAction =
  | "STOP_CONTACT"
  | "HUMAN_HANDOFF"
  | "REPAIR_EXPERIENCE"
  | "DISCOVER_AGENCY_PROFILE"
  | "DISCOVER_PAIN"
  | "EXPLAIN_CONSEQUENCE"
  | "GENERATE_DIAGNOSIS"
  | "RUN_DEMONSTRATION"
  | "HANDLE_OBJECTION"
  | "SUPPORT_DECISION_MAKER"
  | "RECOMMEND_CAPABILITY"
  | "INVITE_TRIAL"
  | "MOVE_TO_SUBSCRIPTION";

export type DemoPath =
  | "WHATSAPP_LEAD_HANDLING"
  | "LEAD_QUALIFICATION"
  | "PACKAGE_RECOMMENDATION"
  | "OBJECTION_HANDLING"
  | "QUOTATION_GENERATION"
  | "FOLLOW_UP"
  | "BUYING_SIGNAL_DETECTION"
  | "HUMAN_HANDOFF"
  | "SALES_INTELLIGENCE"
  | "BUSINESS_ORCHESTRATION";

const DEMO_FOR_GAP: Record<B2bGapKey, DemoPath> = {
  response: "WHATSAPP_LEAD_HANDLING",
  after_hours: "WHATSAPP_LEAD_HANDLING",
  followup: "FOLLOW_UP",
  qualification: "LEAD_QUALIFICATION",
  prioritisation: "SALES_INTELLIGENCE",
  quotation: "QUOTATION_GENERATION",
  manual_work: "BUSINESS_ORCHESTRATION",
  automation: "BUSINESS_ORCHESTRATION",
  capacity: "WHATSAPP_LEAD_HANDLING",
  experience: "OBJECTION_HANDLING",
};

const CAPABILITY_FOR_GAP: Record<B2bGapKey, string> = {
  response: "whatsapp",
  after_hours: "whatsapp",
  followup: "orchestrator",
  qualification: "whatsapp",
  prioritisation: "lead_intel",
  quotation: "whatsapp",
  manual_work: "orchestrator",
  automation: "orchestrator",
  capacity: "whatsapp",
  experience: "whatsapp",
};

/* ------------------------------------------------------------------ *
 * Agency facts (§3, §4)
 * ------------------------------------------------------------------ */

export type AgencyFacts = {
  salesTeam: number | null;
  monthlyEnquiries: number | null;
  channelWhatsapp: boolean;
  crmNamed: string | null;
  responseSpeed: "FAST" | "DELAYED" | null;
  afterHours: "COVERED" | "GAP" | null;
  followup: "STRUCTURED" | "MANUAL" | null;
  qualification: "MANUAL" | null;
  prioritisation: "EXISTS" | "GAP" | null;
  quotation: "MANUAL" | null;
  automation: "PARTIAL" | "MINIMAL" | null;
  marketing: string | null;
};

const NUM = String.raw`(\d[\d,]*)`;

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstMatch(text: string, re: RegExp): RegExpExecArray | null {
  return re.exec(text);
}

function evidence(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[0].trim().slice(0, 90) : null;
}

export function extractAgencyFacts(visitorMessages: string[]): AgencyFacts {
  const norm = visitorMessages.map((m) => normalizeMessage(m));
  const masked = norm.map((m) => maskNegatedSpans(m)).join("\n");
  const joined = norm.join("\n");

  const team = firstMatch(
    joined,
    new RegExp(
      `${NUM}\\s*(?:orang|staff|staf|sales|consultant|consultants|agent|agents|team\\s*member[s]?)`,
      "i",
    ),
  );
  const teamAlt = firstMatch(
    joined,
    new RegExp(`(?:sales|team|staff|consultant[s]?)\\s*(?:saya|kami|we|i)?\\s*(?:ada|have|:)?\\s*${NUM}`, "i"),
  );

  const enquiries = firstMatch(
    joined,
    new RegExp(
      `${NUM}\\s*(?:\\+)?\\s*(?:lebih\\s*)?(?:enquiry|enquiries|inquiry|inquiries|lead|leads|mesej|message|messages|pertanyaan|prospek|chat)`,
      "i",
    ),
  );
  const enquiriesAlt = firstMatch(
    joined,
    new RegExp(`(?:enquiry|enquiries|lead|leads|mesej|message[s]?)\\D{0,20}${NUM}`, "i"),
  );

  const crm = firstMatch(joined, /\b(hubspot|zoho|salesforce|pipedrive|odoo|excel|spreadsheet|google\s+sheet[s]?)\b/i);

  // STEP 3E — capacity phrasing ("tak sempat", "can't reply fast enough") is a
  // stated pain, not a negated claim, so it is read from the raw text. Bare
  // "slow" only counts as a response gap when it sits in a response context —
  // "sales saya slow" must not be diagnosed as a reply-speed problem.
  const RESPONSE_DELAY_PHRASE =
    /\b(lambat\s*(sikit\s*)?(nak\s*)?(reply|balas|respond|jawab)|(reply|balas|respond|jawab)\s*\w{0,6}\s*(lambat|slow|lewat)|slow\s+(to\s+)?(reply|respond|response)|(can'?t|cannot|tak\s+boleh|tak\s+sempat|tidak\s+sempat|tak\s+larat|no\s+time\s+to)\s+(reply|balas|respond|jawab|layan)\w*|esok\s+baru|next\s+day|overnight|berjam|terlepas\s+(lead|enquiry|enquiries|mesej|message|prospek)|miss(ed)?\s+(lead|enquiry|message))\b/i;
  const RESPONSE_CONTEXT =
    /\b(reply|balas|respond|response|jawab|enquiry|enquiries|whatsapp|mesej|message|customer|prospek|lead)\b/i;
  const delayed =
    RESPONSE_DELAY_PHRASE.test(joined) ||
    (/\b(lambat|slow|delay\w*|lewat)\b/i.test(masked) && RESPONSE_CONTEXT.test(masked));
  const fast =
    /\b(reply|respond|balas)\D{0,20}\b(segera|instantly|immediately|within\s+minutes|dalam\s+beberapa\s+minit)\b/i.test(
      masked,
    );

  const afterHoursGap =
    /\b(after\s*office|selepas\s+office|lepas\s+office|malam|midnight|tengah\s+malam|weekend|hujung\s+minggu|cuti|public\s+holiday|after\s+hours?)\b/i.test(
      masked,
    ) && /\b(tak|tidak|no|belum|esok|next\s+day|lambat|slow|nobody|tiada)\b/i.test(joined);
  const afterHoursCovered = /\b24\/7|24\s*jam|round\s+the\s+clock|shift\s+malam\b/i.test(masked);

  // STEP 3E — "team tak sempat follow-up" / "follow-up lemah" are the most
  // common ways an agency states this pain and must register as a real gap.
  const followupWeak =
    /\b(tak|tidak|jarang|kurang|lupa|terlepas|belum|no|never)\b[\w\s'’-]{0,20}?follow[\s-]?up\b/i.test(joined) ||
    /\bfollow[\s-]?up\b[\w\s'’-]{0,20}?\b(lemah|lembab|lambat|tak\s+konsisten|inconsistent|manual|lupa|terlepas)\b/i.test(
      joined,
    );
  const followupManual =
    followupWeak ||
    (/\b(follow[\s-]?up)\b/i.test(joined) &&
      /\b(manual|lupa|forget|tak\s+konsisten|inconsistent|ad\s*hoc|tiada|no\s+system|by\s+memory|ingat)\b/i.test(joined));
  const followupStructured =
    /\bfollow[\s-]?up\b/i.test(joined) &&
    /\b(automated|automatik|scheduled|reminder|sistem|system|crm)\b/i.test(masked);

  const qualificationManual =
    /\b(manual|satu-satu|one\s+by\s+one|soalan\s+sama|same\s+questions|repetitive|berulang|copy\s+paste)\b/i.test(
      masked,
    );

  const prioritisationGap =
    // STEP 3E — must be about which ENQUIRY to act on, not any vague uncertainty
    // ("tak tahu dekat mana masalah" is not a prioritisation gap).
    /\b(tak\s+tahu|tidak\s+tahu|susah|hard|cannot|can'?t|don'?t\s+know)\b[^.?!]{0,40}\b(mana|which|siapa|who)\b[^.?!]{0,30}\b(lead|leads|enquiry|enquiries|customer|pelanggan|prospek|serious|betul[\s-]?betul|nak\s+beli|priorit|hot)\b/i.test(
      joined,
    ) ||
    /\b(tak\s+tahu|tidak\s+tahu|susah|hard|cannot|can'?t|don'?t\s+know)\b[^.?!]{0,40}\b(serious|high[\s-]?intent|priorit|hot\s+lead)\b/i.test(
      joined,
    ) || /\b(semua\s+lead|all\s+leads)\b[^.?!]{0,25}\b(sama|same)\b/i.test(joined);
  const prioritisationExists = /\b(lead\s*scor|priorit\w+\s+(by|ikut)|hot\s+lead\s+list)\b/i.test(masked);

  const quotationManual =
    /\b(quotation|quote|sebut\s?harga|invois|invoice)\b/i.test(joined) &&
    /\b(manual|lambat|slow|excel|word|typed?|taip|lama|hours?|berjam)\b/i.test(joined);

  const automationPartial = /\b(guna|using|we\s+use|dah\s+ada)\b[^.?!]{0,25}\b(crm|chatbot|automation|autoresponder|sistem)\b/i.test(
    masked,
  );
  const automationMinimal =
    /\b(tiada|tak\s+ada|belum\s+ada|no)\b[^.?!]{0,25}\b(automation|automasi|system|sistem|crm|tool)\b/i.test(joined) ||
    /\b(whatsapp\s+(sahaja|only|je)|excel|buku|pen\s+and\s+paper|manual\s+semua)\b/i.test(joined);

  const marketing = evidence(
    joined,
    /\b(facebook\s*ads?|fb\s*ads?|google\s*ads?|tiktok|instagram|ig|referral|walk[\s-]?in|agent\s+network|whatsapp\s+blast)\b/i,
  );

  return {
    salesTeam: num(team?.[1]) ?? num(teamAlt?.[1]),
    monthlyEnquiries: num(enquiries?.[1]) ?? num(enquiriesAlt?.[1]),
    channelWhatsapp: /\bwhatsapp|wasap|wa\b/i.test(joined),
    crmNamed: crm?.[1] ?? null,
    responseSpeed: delayed ? "DELAYED" : fast ? "FAST" : null,
    afterHours: afterHoursGap ? "GAP" : afterHoursCovered ? "COVERED" : null,
    followup: followupManual ? "MANUAL" : followupStructured ? "STRUCTURED" : null,
    qualification: qualificationManual ? "MANUAL" : null,
    prioritisation: prioritisationGap ? "GAP" : prioritisationExists ? "EXISTS" : null,
    quotation: quotationManual ? "MANUAL" : null,
    automation: automationPartial ? "PARTIAL" : automationMinimal ? "MINIMAL" : null,
    marketing,
  };
}

/* ------------------------------------------------------------------ *
 * B2B buying-readiness signals (§11)
 * ------------------------------------------------------------------ */

const DEMO_REQUEST =
  /\b(demo|tunjuk|tunjukkan|show\s+me|boleh\s+tengok|can\s+i\s+see|example|contoh|try\s+it|test\s+umraio|nak\s+test|cuba)\b/i;
const TRIAL_INTENT =
  /\b(trial|percubaan|free\s+trial|nak\s+cuba\s+(guna|pakai)|start\s+trial|onboard|nak\s+mula|how\s+do\s+i\s+start|macam\s?mana\s+nak\s+mula)\b/i;
const SUBSCRIPTION_INTENT =
  /\b(subscribe|subscription|langgan|plan|pakej\s+umraio|pricing|berapa\s+bayaran|monthly\s+fee|sign\s+up|daftar)\b/i;
const SIMULATION_REQUEST =
  /\b(customer\s+(saya\s+)?(tanya|kata|cakap|ask|say)|kalau\s+customer|if\s+(a\s+)?customer|pretend|anggap\s+saya\s+customer|test\s+dengan)\b/i;

/* ------------------------------------------------------------------ *
 * Aggregate intelligence
 * ------------------------------------------------------------------ */

export type Diagnosis = {
  working: string[];
  primaryOpportunity: B2bGap;
  secondaryOpportunity: B2bGap | null;
  commercialRelevance: string;
  umraioResponse: string;
  nextStep: string;
};

export type MeetIntelligence = {
  answered: number;
  language: LanguageCode | "auto";
  languageSource: string;
  style: ConversationalStyle;
  facts: AgencyFacts;
  snapshot: SnapshotRow[];
  gaps: B2bGap[];
  detectedGaps: B2bGap[];
  objections: ObjectionRead[];
  behavioral: BehavioralProfile;
  stage: B2bStage;
  nextBestAction: B2bNextBestAction;
  demoPath: DemoPath | null;
  simulationRequested: boolean;
  optedOut: boolean;
  humanRequested: boolean;
  frustration: FrustrationSignal[];
  diagnosis: Diagnosis | null;
  recommendedCapabilities: string[];
  missingFacts: string[];
  headline: string | null;
};

function gapRow(
  key: B2bGapKey,
  status: GapStatus,
  detail: string,
  consequence: string | null,
  ev: string | null,
): B2bGap {
  return { key, label: GAP_LABEL[key], status, detail, consequence, evidence: ev };
}

export function analyzeMeetConversation(messages: DemoMessage[]): MeetIntelligence {
  const visitor = messages.filter((m) => m.role === "visitor").map((m) => m.content);
  const executive = messages.filter((m) => m.role === "executive").map((m) => m.content);
  const joinedRaw = visitor.join("\n");
  const joined = normalizeMessage(joinedRaw);
  const masked = maskNegatedSpans(joined);
  const latest = visitor.length ? visitor[visitor.length - 1]! : "";

  const facts = extractAgencyFacts(visitor);

  const optedOut = conversationOptedOut(visitor).optedOut;
  const humanRequested = visitor.slice(-3).some((m) => detectHumanRequest(m));
  const frustration = detectFrustration(latest);

  const behavioral = buildBehavioralProfile({
    customerMessages: visitor,
    agentMessages: executive,
    optedOut,
    humanTakeover: humanRequested,
    knownCount: Object.values(facts).filter((v) => v !== null && v !== false).length,
  });

  const lang = resolveReplyLanguage({ recentCustomerMessages: visitor });
  const style = detectConversationalStyle(visitor);

  /* ---- objections with lifecycle ---- */
  const objections: ObjectionRead[] = [];
  for (const { cat, re } of OBJECTION_PATTERNS) {
    let lastIdx = -1;
    for (let i = 0; i < visitor.length; i += 1) {
      if (re.test(normalizeMessage(visitor[i]!))) lastIdx = i;
    }
    if (lastIdx === -1) continue;
    const resolvedLater = visitor
      .slice(lastIdx + 1)
      .some((m) => detectObjectionResolution(m));
    objections.push({
      category: cat,
      status: resolvedLater ? "RESOLVED" : "ACTIVE",
      evidence: evidence(normalizeMessage(visitor[lastIdx]!), re) ?? "",
    });
  }
  const activeObjections = objections.filter((o) => o.status === "ACTIVE");

  /* ---- gaps ---- */
  const gaps: B2bGap[] = [];

  gaps.push(
    facts.responseSpeed === "DELAYED"
      ? gapRow(
          "response",
          "DETECTED",
          "New enquiries appear to wait before receiving a first reply.",
          "Enquiries that wait are more likely to go quiet before a consultant reaches them.",
          evidence(joined, /\b(lambat|slow|delay|lewat|esok\s+baru|tak\s+sempat)\b/i),
        )
      : facts.responseSpeed === "FAST"
        ? gapRow("response", "COVERED", "A fast first reply is already in place.", null, null)
        : /\b(reply|balas|respond|response)\b/i.test(joined)
          ? gapRow("response", "ASSESSING", "Response handling mentioned; speed not yet established.", null, null)
          : gapRow("response", "NOT_YET_ESTABLISHED", "Response workflow not discussed yet.", null, null),
  );

  gaps.push(
    facts.afterHours === "GAP"
      ? gapRow(
          "after_hours",
          "DETECTED",
          "Enquiries arriving outside office hours are not answered the same day.",
          "Enquiries received at night compete with agencies that reply immediately.",
          evidence(joined, /\b(malam|after\s*office|lepas\s+office|weekend|cuti)\b/i),
        )
      : facts.afterHours === "COVERED"
        ? gapRow("after_hours", "COVERED", "After-hours coverage is already handled.", null, null)
        : gapRow("after_hours", "NOT_YET_ESTABLISHED", "After-hours coverage not discussed yet.", null, null),
  );

  gaps.push(
    facts.followup === "MANUAL"
      ? gapRow(
          "followup",
          "DETECTED",
          "Follow-up appears manual or inconsistent after first contact.",
          "Leads that were interested but not ready can be lost simply because nobody returned to them.",
          evidence(joined, /\bfollow[\s-]?up\b[^.?!]{0,30}/i),
        )
      : facts.followup === "STRUCTURED"
        ? gapRow("followup", "COVERED", "A structured follow-up routine already exists.", null, null)
        : /\bfollow[\s-]?up\b/i.test(joined)
          ? gapRow("followup", "ASSESSING", "Follow-up mentioned; consistency not yet established.", null, null)
          : gapRow("followup", "NOT_YET_ESTABLISHED", "Follow-up process not discussed yet.", null, null),
  );

  gaps.push(
    facts.qualification === "MANUAL"
      ? gapRow(
          "qualification",
          "DETECTED",
          "Qualification and repetitive questions consume consultant time.",
          "Time spent on repeated questions is time not spent on prospects that are ready to book.",
          evidence(masked, /\b(manual|satu-satu|soalan\s+sama|same\s+questions|repetitive)\b/i),
        )
      : gapRow("qualification", "NOT_YET_ESTABLISHED", "Qualification method not discussed yet.", null, null),
  );

  gaps.push(
    facts.prioritisation === "GAP"
      ? gapRow(
          "prioritisation",
          "DETECTED",
          "High-intent prospects are not consistently identified first.",
          "Without prioritisation, ready-to-book enquiries are handled at the same pace as casual ones.",
          evidence(joined, /\b(mana|which|priorit\w+|serious)\b/i),
        )
      : facts.prioritisation === "EXISTS"
        ? gapRow("prioritisation", "COVERED", "Some prioritisation already exists.", null, null)
        : gapRow("prioritisation", "NOT_YET_ESTABLISHED", "Lead prioritisation not discussed yet.", null, null),
  );

  gaps.push(
    facts.quotation === "MANUAL"
      ? gapRow(
          "quotation",
          "DETECTED",
          "Quotations appear to be prepared manually.",
          "A slow quotation step delays the moment a customer can actually decide.",
          evidence(joined, /\b(quotation|quote|sebut\s?harga|invois)\b/i),
        )
      : /\b(quotation|quote|sebut\s?harga)\b/i.test(joined)
        ? gapRow("quotation", "ASSESSING", "Quotation workflow mentioned; speed not yet established.", null, null)
        : gapRow("quotation", "NOT_YET_ESTABLISHED", "Quotation workflow not discussed yet.", null, null),
  );

  gaps.push(
    facts.automation === "MINIMAL"
      ? gapRow(
          "automation",
          "DETECTED",
          "Core enquiry handling runs without automation support.",
          "Every step depending on a person is a step that stops when the person is unavailable.",
          evidence(joined, /\b(tiada|tak\s+ada|excel|whatsapp\s+(sahaja|only|je))\b/i),
        )
      : facts.automation === "PARTIAL" || facts.crmNamed
        ? gapRow("automation", "COVERED", "Some tooling already exists in the workflow.", null, null)
        : gapRow("automation", "NOT_YET_ESTABLISHED", "Current tooling not discussed yet.", null, null),
  );

  const heavyLoad =
    facts.monthlyEnquiries !== null &&
    facts.salesTeam !== null &&
    facts.monthlyEnquiries / Math.max(facts.salesTeam, 1) >= 100;
  gaps.push(
    heavyLoad
      ? gapRow(
          "capacity",
          "DETECTED",
          "Enquiry volume per consultant is high relative to the team size stated.",
          "At this ratio, consistent same-day handling depends heavily on individual effort.",
          `${facts.monthlyEnquiries} enquiries / ${facts.salesTeam} consultants (as stated)`,
        )
      : facts.monthlyEnquiries === null || facts.salesTeam === null
        ? gapRow("capacity", "NOT_YET_ESTABLISHED", "Volume-to-team ratio not yet established.", null, null)
        : gapRow("capacity", "COVERED", "Volume appears manageable for the stated team size.", null, null),
  );

  const manualWork =
    facts.qualification === "MANUAL" || facts.followup === "MANUAL" || facts.quotation === "MANUAL";
  gaps.push(
    manualWork
      ? gapRow(
          "manual_work",
          "DETECTED",
          "Several recurring steps are performed manually.",
          "Manual repetition limits how many enquiries the same team can handle well.",
          null,
        )
      : gapRow("manual_work", "NOT_YET_ESTABLISHED", "Manual workload not established yet.", null, null),
  );

  const experienceIssue =
    /\b(customer\s+(complain|merungut|marah|kecewa)|complaint|aduan|customer\s+tunggu|lambat\s+dapat\s+jawapan)\b/i.test(
      joined,
    );
  gaps.push(
    experienceIssue
      ? gapRow(
          "experience",
          "DETECTED",
          "Customer experience issues were mentioned directly.",
          "Experience issues affect referrals as much as conversion.",
          evidence(joined, /\b(complain|merungut|aduan|kecewa)\b/i),
        )
      : gapRow("experience", "NOT_YET_ESTABLISHED", "Customer experience not discussed yet.", null, null),
  );

  const detectedGaps = gaps.filter((g) => g.status === "DETECTED");

  /* ---- snapshot rows (only relevant dimensions) ---- */
  const snapshot: SnapshotRow[] = [];
  const row = (key: string, label: string, value: string | null, status: FactStatus) => {
    snapshot.push({ key, label, value: value ?? FACT_STATUS_LABEL[status], status });
  };

  row(
    "team",
    "Sales consultants",
    facts.salesTeam !== null ? `${facts.salesTeam} (as stated)` : null,
    facts.salesTeam !== null ? "CONFIRMED" : "NOT_PROVIDED",
  );
  row(
    "volume",
    "Monthly enquiries",
    facts.monthlyEnquiries !== null ? `${facts.monthlyEnquiries} per month (as stated)` : null,
    facts.monthlyEnquiries !== null ? "CONFIRMED" : "NOT_PROVIDED",
  );
  if (facts.channelWhatsapp) row("channel", "Primary channel", "WhatsApp (as stated)", "CONFIRMED");
  row(
    "response",
    "Response speed",
    facts.responseSpeed === "DELAYED"
      ? "Delayed first response"
      : facts.responseSpeed === "FAST"
        ? "Fast first response"
        : null,
    facts.responseSpeed ? "DETECTED" : /\b(reply|balas|respond)\b/i.test(joined) ? "ASSESSING" : "NOT_YET_ESTABLISHED",
  );
  row(
    "after_hours",
    "After-hours coverage",
    facts.afterHours === "GAP" ? "Not covered same day" : facts.afterHours === "COVERED" ? "Covered" : null,
    facts.afterHours ? "DETECTED" : "NOT_YET_ESTABLISHED",
  );
  row(
    "followup",
    "Follow-up process",
    facts.followup === "MANUAL" ? "Manual / inconsistent" : facts.followup === "STRUCTURED" ? "Structured" : null,
    facts.followup ? "DETECTED" : /\bfollow[\s-]?up\b/i.test(joined) ? "ASSESSING" : "NOT_YET_ESTABLISHED",
  );
  if (facts.qualification || /\bqualif|layak|tapis\b/i.test(joined))
    row(
      "qualification",
      "Lead qualification",
      facts.qualification === "MANUAL" ? "Manual" : null,
      facts.qualification ? "DETECTED" : "NEEDS_MORE_INFORMATION",
    );
  if (facts.prioritisation || /\bpriorit|hot\s+lead\b/i.test(joined))
    row(
      "prioritisation",
      "Lead prioritisation",
      facts.prioritisation === "GAP" ? "Not established" : facts.prioritisation === "EXISTS" ? "In place" : null,
      facts.prioritisation ? "DETECTED" : "NEEDS_MORE_INFORMATION",
    );
  if (facts.quotation || /\b(quotation|quote|sebut\s?harga)\b/i.test(joined))
    row(
      "quotation",
      "Quotation workflow",
      facts.quotation === "MANUAL" ? "Manual" : null,
      facts.quotation ? "DETECTED" : "ASSESSING",
    );
  row(
    "automation",
    "Automation / tooling",
    facts.crmNamed
      ? `${facts.crmNamed} (as stated)`
      : facts.automation === "PARTIAL"
        ? "Partial tooling"
        : facts.automation === "MINIMAL"
          ? "Minimal"
          : null,
    facts.crmNamed || facts.automation ? "CONFIRMED" : "NOT_YET_ESTABLISHED",
  );
  if (facts.marketing) row("marketing", "Lead acquisition", `${facts.marketing} (as stated)`, "CONFIRMED");

  /* ---- missing facts, in discovery priority order ---- */
  const missingFacts: string[] = [];
  if (facts.salesTeam === null) missingFacts.push("sales team size");
  if (facts.monthlyEnquiries === null) missingFacts.push("monthly WhatsApp enquiry volume");
  if (!facts.responseSpeed) missingFacts.push("first-response speed");
  if (!facts.afterHours) missingFacts.push("after-hours coverage");
  if (!facts.followup) missingFacts.push("follow-up process");
  if (!facts.qualification) missingFacts.push("how leads are qualified");
  if (!facts.prioritisation) missingFacts.push("how leads are prioritised");
  if (!facts.quotation) missingFacts.push("quotation workflow");
  if (!facts.automation && !facts.crmNamed) missingFacts.push("current tools or CRM");

  /* ---- stage ---- */
  const demoRequested = DEMO_REQUEST.test(masked);
  const simulationRequested = SIMULATION_REQUEST.test(joined);
  const trialInterest = TRIAL_INTENT.test(masked);
  const subscriptionInterest = SUBSCRIPTION_INTENT.test(masked);
  const knownCount = [
    facts.salesTeam !== null,
    facts.monthlyEnquiries !== null,
    facts.responseSpeed !== null,
    facts.afterHours !== null,
    facts.followup !== null,
    facts.qualification !== null,
    facts.prioritisation !== null,
    facts.quotation !== null,
    facts.automation !== null,
  ].filter(Boolean).length;

  let stage: B2bStage;
  if (optedOut) stage = "DO_NOT_CONTACT";
  else if (humanRequested) stage = "HUMAN_HANDOFF";
  else if (subscriptionInterest) stage = "SUBSCRIPTION_READY";
  else if (trialInterest) stage = "TRIAL_READY";
  else if (demoRequested || simulationRequested) stage = "DEMO_READY";
  else if (detectedGaps.length && knownCount >= 3) stage = "SOLUTION_AWARE";
  else if (detectedGaps.length) stage = "PROBLEM_AWARE";
  else if (visitor.length >= 1) stage = "CURIOUS";
  else stage = "LOW_INTENT";

  const highIntent = stage === "TRIAL_READY" || stage === "SUBSCRIPTION_READY";

  /* ---- diagnosis (only with evidence) ---- */
  const diagnosisReady = detectedGaps.length >= 1 && knownCount >= 3 && visitor.length >= 3;
  const primary = detectedGaps[0] ?? null;
  const diagnosis: Diagnosis | null =
    diagnosisReady && primary
      ? {
          working: gaps.filter((g) => g.status === "COVERED").map((g) => g.detail),
          primaryOpportunity: primary,
          secondaryOpportunity: detectedGaps[1] ?? null,
          commercialRelevance:
            primary.consequence ??
            "This step currently depends on individual availability rather than a repeatable process.",
          umraioResponse: `UMRAIO would address this with ${CAPABILITY_FOR_GAP[primary.key]} capability, coordinated by the AI Autonomous Business Executive™.`,
          nextStep:
            "Start with the lowest-risk step — a live demonstration on one real enquiry pattern, or a free trial on your own workflow.",
        }
      : null;

  /* ---- next best action ---- */
  let nextBestAction: B2bNextBestAction;
  if (optedOut) nextBestAction = "STOP_CONTACT";
  else if (humanRequested) nextBestAction = "HUMAN_HANDOFF";
  else if (frustration.length) nextBestAction = "REPAIR_EXPERIENCE";
  else if (activeObjections.some((o) => o.category === "NEEDS_PARTNER_APPROVAL"))
    nextBestAction = "SUPPORT_DECISION_MAKER";
  else if (activeObjections.length) nextBestAction = "HANDLE_OBJECTION";
  else if (subscriptionInterest) nextBestAction = "MOVE_TO_SUBSCRIPTION";
  else if (trialInterest) nextBestAction = "INVITE_TRIAL";
  else if (demoRequested || simulationRequested) nextBestAction = "RUN_DEMONSTRATION";
  else if (diagnosis) nextBestAction = "RECOMMEND_CAPABILITY";
  else if (diagnosisReady) nextBestAction = "GENERATE_DIAGNOSIS";
  else if (detectedGaps.length && knownCount >= 2) nextBestAction = "EXPLAIN_CONSEQUENCE";
  else if (facts.salesTeam !== null || facts.monthlyEnquiries !== null) nextBestAction = "DISCOVER_PAIN";
  else nextBestAction = "DISCOVER_AGENCY_PROFILE";

  // STEP 3E — a demonstration is grounded as soon as a real gap is evidenced;
  // it stays personalised because the path always follows the detected gap.
  const demoPath =
    nextBestAction === "RUN_DEMONSTRATION" || diagnosis || primary
      ? primary
        ? DEMO_FOR_GAP[primary.key]
        : "WHATSAPP_LEAD_HANDLING"
      : null;

  const recommendedCapabilities = Array.from(
    new Set(detectedGaps.map((g) => CAPABILITY_FOR_GAP[g.key])),
  );

  const headline = primary
    ? `Strongest opportunity detected: ${primary.label.toLowerCase().replace(" gap", "")}.`
    : null;

  return {
    answered: visitor.length,
    language: lang.language,
    languageSource: lang.source,
    style,
    facts,
    snapshot,
    gaps,
    detectedGaps,
    objections,
    behavioral,
    stage,
    nextBestAction,
    demoPath,
    simulationRequested,
    optedOut,
    humanRequested,
    frustration,
    diagnosis,
    recommendedCapabilities,
    missingFacts,
    headline: highIntent ? headline : headline,
  };
}

/* ------------------------------------------------------------------ *
 * Executive brief (§16) — concise and actionable, human-facing
 * ------------------------------------------------------------------ */

export function buildMeetExecutiveBrief(intel: MeetIntelligence): string {
  const f = intel.facts;
  const lines: string[] = ["UMRAIO EXECUTIVE BRIEF", "", "AGENCY PROFILE"];
  lines.push(`Sales team: ${f.salesTeam ?? "Not provided"}`);
  lines.push(`Lead volume: ${f.monthlyEnquiries !== null ? `${f.monthlyEnquiries}/month (as stated)` : "Not provided"}`);
  lines.push(`Primary channel: ${f.channelWhatsapp ? "WhatsApp" : "Not established"}`);
  lines.push(`Current tooling: ${f.crmNamed ?? (f.automation ? f.automation.toLowerCase() : "Not established")}`);

  lines.push("", "KEY OPPORTUNITY");
  lines.push(intel.detectedGaps[0]?.label ?? "Not yet established");
  if (intel.detectedGaps[1]) {
    lines.push("", "SECONDARY OPPORTUNITY", intel.detectedGaps[1].label);
  }

  const b = intel.behavioral;
  lines.push("", "BEHAVIOURAL READ");
  lines.push(`Strategy: ${b.strategy}`);
  lines.push(`Trust: ${b.trust.value} · Hesitation: ${b.hesitation.value} · Closing readiness: ${b.closingReadiness.value}`);
  lines.push(`Stage: ${intel.stage}`);

  const active = intel.objections.filter((o) => o.status === "ACTIVE").map((o) => o.category);
  lines.push("", "OBJECTIONS", active.length ? active.join(", ") : "None active");

  lines.push("", "RECOMMENDED DEMO", intel.demoPath ?? "Not yet established");
  lines.push("", "NEXT BEST ACTION", intel.nextBestAction);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Prompt instruction (§2, §3, §5, §7-§13, §18)
 * ------------------------------------------------------------------ */

const NBA_DIRECTIVE: Record<B2bNextBestAction, string> = {
  STOP_CONTACT:
    "The visitor asked to stop. Acknowledge once, stop selling entirely, offer nothing further.",
  HUMAN_HANDOFF:
    "The visitor asked for a human. STOP autonomous selling immediately. Acknowledge, confirm their request is recorded via the Talk to our team button, and ask nothing further about their business.",
  REPAIR_EXPERIENCE:
    "The visitor is frustrated. Acknowledge honestly, do not re-ask anything already answered, and offer a human colleague.",
  DISCOVER_AGENCY_PROFILE:
    "Ask exactly ONE question that establishes the most useful missing profile fact.",
  DISCOVER_PAIN:
    "Profile basics are known. Ask ONE question that surfaces where the sales workflow actually breaks.",
  EXPLAIN_CONSEQUENCE:
    "A real gap was evidenced. State the business consequence in plain language, without exaggeration or numbers, then ask ONE clarifying question.",
  GENERATE_DIAGNOSIS:
    "Enough evidence exists. Produce a short YOUR UMRAIO BUSINESS DIAGNOSIS™: what works, the strongest opportunity, why it matters, how UMRAIO addresses it, what to do next.",
  RUN_DEMONSTRATION:
    "Demonstrate rather than explain. Use the recommended demo path only. If they gave a customer message, answer it exactly as UMRAIO would answer their real customer, then point out that this is the same intelligence that would run on their leads.",
  HANDLE_OBJECTION:
    "Handle the active objection with ACKNOWLEDGE → CLARIFY → ADDRESS → PROVE → CONFIRM. Never argue, never pressure.",
  SUPPORT_DECISION_MAKER:
    "They must consult someone. Give a short forwardable summary and propose checking back. No pressure.",
  RECOMMEND_CAPABILITY:
    "Recommend only the capabilities that match the evidenced gaps, then propose the lowest-risk next step.",
  INVITE_TRIAL:
    "They are trial-ready. Stop selling and move them to the Choose a Plan button on this page.",
  MOVE_TO_SUBSCRIPTION:
    "They asked about subscribing. Do not invent pricing. Direct them to Choose a Plan or Talk to our team so a specialist can confirm the plan.",
};

const DEMO_DIRECTIVE: Record<DemoPath, string> = {
  WHATSAPP_LEAD_HANDLING: "Show how an inbound WhatsApp enquiry is received, answered and captured.",
  LEAD_QUALIFICATION: "Show how the required lead details are collected conversationally, not as a form.",
  PACKAGE_RECOMMENDATION: "Show how a package would be recommended from stated requirements only.",
  OBJECTION_HANDLING: "Show how a customer objection is handled without pressure.",
  QUOTATION_GENERATION: "Show how a quotation is prepared from verified package data.",
  FOLLOW_UP: "Show how follow-up is scheduled and personalised to the last real conversation.",
  BUYING_SIGNAL_DETECTION: "Show how buying signals are detected and escalated.",
  HUMAN_HANDOFF: "Show how a human takeover request stops automated messaging.",
  SALES_INTELLIGENCE: "Show how leads are scored and prioritised deterministically.",
  BUSINESS_ORCHESTRATION: "Show how the executive prioritises and coordinates the next action across workers.",
};

export function meetExecutiveInstruction(intel: MeetIntelligence): string {
  const lines: string[] = [
    "MEET YOUR UMRAIO EXECUTIVE™ — B2B situational intelligence (deterministic, derived only from this conversation). This is context, never text to repeat.",
    `Funnel stage: ${intel.stage}. Next best action: ${intel.nextBestAction} — ${NBA_DIRECTIVE[intel.nextBestAction]}`,
  ];

  if (intel.language !== "auto")
    lines.push(
      `Detected visitor language: ${intel.language} (source: ${intel.languageSource}), writing style: ${intel.style}. Reply in the same language and register. If they switch, follow naturally. Never ask them to choose a language.`,
    );

  const known: string[] = [];
  const f = intel.facts;
  if (f.salesTeam !== null) known.push(`sales team = ${f.salesTeam}`);
  if (f.monthlyEnquiries !== null) known.push(`monthly enquiries = ${f.monthlyEnquiries}`);
  if (f.channelWhatsapp) known.push("primary channel = WhatsApp");
  if (f.crmNamed) known.push(`tooling = ${f.crmNamed}`);
  if (f.responseSpeed) known.push(`response speed = ${f.responseSpeed}`);
  if (f.afterHours) known.push(`after-hours = ${f.afterHours}`);
  if (f.followup) known.push(`follow-up = ${f.followup}`);
  if (f.qualification) known.push("qualification = MANUAL");
  if (f.prioritisation) known.push(`prioritisation = ${f.prioritisation}`);
  if (f.quotation) known.push("quotation = MANUAL");
  if (f.automation) known.push(`automation = ${f.automation}`);
  if (known.length) lines.push(`ALREADY KNOWN — never ask again: ${known.join("; ")}.`);
  if (intel.missingFacts.length)
    lines.push(`Still unknown, in priority order: ${intel.missingFacts.slice(0, 4).join(", ")}. Ask at most ONE of these.`);

  if (intel.detectedGaps.length)
    lines.push(
      `Evidenced opportunities: ${intel.detectedGaps.map((g) => `${g.label} (${g.evidence ?? "stated"})`).join("; ")}. Only these may be described as detected.`,
    );
  else lines.push("No opportunity has been evidenced yet. Do not claim to have detected a problem.");

  const active = intel.objections.filter((o) => o.status === "ACTIVE");
  if (active.length)
    lines.push(
      `Active objections: ${active.map((o) => `${o.category} → ${B2B_OBJECTION_PLAYBOOK[o.category]}`).join(" | ")}`,
    );
  const resolved = intel.objections.filter((o) => o.status === "RESOLVED");
  if (resolved.length)
    lines.push(`Resolved objections (do not reopen): ${resolved.map((o) => o.category).join(", ")}.`);

  if (intel.diagnosis)
    lines.push(
      `Diagnosis is now supported by evidence. Primary: ${intel.diagnosis.primaryOpportunity.label}. Commercial relevance: ${intel.diagnosis.commercialRelevance}`,
    );
  else lines.push("Do NOT produce a business diagnosis yet — insufficient evidence.");

  if (intel.demoPath) lines.push(`Recommended demonstration: ${intel.demoPath} — ${DEMO_DIRECTIVE[intel.demoPath]}`);
  if (intel.simulationRequested)
    lines.push(
      "The visitor is role-playing one of their own customers. Answer as UMRAIO would answer that customer, then briefly note that this is the same intelligence that would handle their real leads.",
    );

  lines.push(behavioralInstruction(intel.behavioral));
  lines.push(
    "B2B ETHICS: never claim guaranteed bookings, revenue, close rate, deposits or ROI; never claim 100% human-like behaviour; never invent pricing, discounts, agency numbers or customer counts. Use 'can help', 'designed to', 'can automate', 'based on what you've shared'. Never continue selling after an opt-out or a human request.",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Conversion events (§14) — derived, never duplicated infrastructure
 * ------------------------------------------------------------------ */

export type MeetEvent =
  | "meet_started"
  | "language_detected"
  | "agency_profile_started"
  | "pain_detected"
  | "business_snapshot_updated"
  | "opportunity_detected"
  | "diagnosis_generated"
  | "demo_requested"
  | "objection_detected"
  | "objection_resolved"
  | "high_intent_detected"
  | "trial_interest"
  | "subscription_interest"
  | "human_handoff_requested";

export function deriveMeetEvents(intel: MeetIntelligence): MeetEvent[] {
  const out: MeetEvent[] = ["meet_started"];
  if (intel.language !== "auto") out.push("language_detected");
  if (intel.facts.salesTeam !== null || intel.facts.monthlyEnquiries !== null)
    out.push("agency_profile_started");
  if (intel.snapshot.some((r) => r.status === "CONFIRMED" || r.status === "DETECTED"))
    out.push("business_snapshot_updated");
  if (intel.detectedGaps.length) out.push("pain_detected", "opportunity_detected");
  if (intel.diagnosis) out.push("diagnosis_generated");
  if (intel.demoPath && (intel.nextBestAction === "RUN_DEMONSTRATION" || intel.simulationRequested))
    out.push("demo_requested");
  if (intel.objections.some((o) => o.status === "ACTIVE")) out.push("objection_detected");
  if (intel.objections.some((o) => o.status === "RESOLVED")) out.push("objection_resolved");
  if (intel.stage === "TRIAL_READY" || intel.stage === "SUBSCRIPTION_READY") out.push("high_intent_detected");
  if (intel.stage === "TRIAL_READY") out.push("trial_interest");
  if (intel.stage === "SUBSCRIPTION_READY") out.push("subscription_interest");
  if (intel.humanRequested) out.push("human_handoff_requested");
  return Array.from(new Set(out));
}
