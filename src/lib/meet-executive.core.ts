/**
 * MEET YOUR AI BUSINESS EXECUTIVE™ — deterministic core.
 *
 * Pure, explainable derivation used by the public product demonstration.
 * Nothing here invents business data: a dimension is only scored when the
 * visitor actually stated something that maps to it, otherwise it stays
 * "Insufficient data". No revenue, ROI or conversion figures are produced.
 */

export type DemoRole = "visitor" | "executive";

export type DemoMessage = { role: DemoRole; content: string };

export type GapKey =
  | "response"
  | "followup"
  | "qualification"
  | "automation"
  | "prioritisation";

export type GapStatus = "insufficient" | "opportunity" | "partial" | "covered";

export type GapFinding = {
  key: GapKey;
  label: string;
  status: GapStatus;
  detail: string;
  evidence: string | null;
};

export type CurrentState = {
  label: string;
  value: string;
};

export type OpportunitySnapshot = {
  ready: boolean;
  answered: number;
  state: CurrentState[];
  gaps: GapFinding[];
  headline: string | null;
  recommended: string[];
};

const NOT_PROVIDED = "Not provided";
const TO_ASSESS = "To be assessed";

const GAP_LABELS: Record<GapKey, string> = {
  response: "Response gap",
  followup: "Follow-up gap",
  qualification: "Qualification gap",
  automation: "Automation gap",
  prioritisation: "Lead prioritisation gap",
};

function match(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const found = re.exec(text);
    if (found) return found[0].trim().slice(0, 80);
  }
  return null;
}

/** Extract a plain enquiry-volume figure only when the visitor states one. */
function extractVolume(text: string): string | null {
  const re =
    /(\d[\d,]*)\s*(?:\+)?\s*(?:enquiries|enquiry|inquiries|leads|messages|mesej|pertanyaan|prospek)/i;
  const found = re.exec(text);
  return found?.[1] ? `${found[1]} per month (as stated)` : null;
}

function extractTeam(text: string): string | null {
  const re = /(\d{1,3})\s*(?:sales\s*)?(?:consultants?|agents?|staff|team members?|orang|staf)/i;
  const found = re.exec(text);
  return found?.[1] ?? null;
}

export function deriveSnapshot(messages: DemoMessage[]): OpportunitySnapshot {
  const visitorText = messages
    .filter((m) => m.role === "visitor")
    .map((m) => m.content)
    .join("\n")
    .toLowerCase();

  const answered = messages.filter((m) => m.role === "visitor").length;

  const volume = extractVolume(visitorText);
  const team = extractTeam(visitorText);

  const slowResponse = match(visitorText, [
    /\b(slow|lambat|delay|late|hours? to reply|next day|overnight|miss(ed|ing)? (leads|enquiries|messages))\b/,
    /\b(cannot|can't|tak sempat|tidak sempat)\b[^.?!]{0,30}\b(reply|respond|balas)\b/,
  ]);
  const fastResponse = match(visitorText, [
    /\b(reply|respond|balas)\b[^.?!]{0,20}\b(instantly|immediately|within minutes|minutes|segera)\b/,
    /\b24\/7\b/,
  ]);

  const weakFollowup = match(visitorText, [
    /\b(no|tiada|tak ada|inconsistent|manual|forget|lupa|ad hoc|ad-hoc)\b[^.?!]{0,30}\bfollow[\s-]?up\b/,
    /\bfollow[\s-]?up\b[^.?!]{0,30}\b(manual|inconsistent|forget|lupa|tiada|whatsapp|excel|memory)\b/,
    /\b(lead|prospek)\b[^.?!]{0,30}\b(stop(s|ped)? reply|ghost|senyap|hilang)\b/,
  ]);
  const hasFollowup = match(visitorText, [
    /\bfollow[\s-]?up\b[^.?!]{0,30}\b(automated|scheduled|reminder|sistem|system|crm)\b/,
  ]);

  const manualQualification = match(visitorText, [
    /\b(manual|by hand|one by one|satu-satu|repetitive|same questions|soalan sama)\b/,
    /\b(qualif\w+)\b[^.?!]{0,25}\b(manual|no process|tiada|sales team)\b/,
  ]);

  const noAutomation = match(visitorText, [
    /\b(no|tiada|tak ada|belum ada)\b[^.?!]{0,25}\b(automation|automated|system|crm|tool)\b/,
    /\b(excel|spreadsheet|whatsapp only|notebook|buku|pen and paper)\b/,
  ]);
  const hasAutomation = match(visitorText, [
    /\b(we use|guna|using)\b[^.?!]{0,25}\b(crm|hubspot|zoho|salesforce|chatbot|automation)\b/,
  ]);

  const noPrioritisation = match(visitorText, [
    /\b(cannot|can't|hard|susah|tak tahu|don't know|no way)\b[^.?!]{0,35}\b(which|who|high[\s-]?intent|serious|priorit\w+)\b/,
    /\b(all leads|semua lead)\b[^.?!]{0,25}\b(same|sama)\b/,
  ]);
  const hasPrioritisation = match(visitorText, [
    /\b(lead\s*scor\w+|prioriti\w+ by|hot leads? list)\b/,
  ]);

  function gap(
    key: GapKey,
    negative: string | null,
    positive: string | null,
    negDetail: string,
    posDetail: string,
  ): GapFinding {
    if (negative) {
      return {
        key,
        label: GAP_LABELS[key],
        status: "opportunity",
        detail: negDetail,
        evidence: negative,
      };
    }
    if (positive) {
      return {
        key,
        label: GAP_LABELS[key],
        status: "partial",
        detail: posDetail,
        evidence: positive,
      };
    }
    return {
      key,
      label: GAP_LABELS[key],
      status: "insufficient",
      detail: "Insufficient data",
      evidence: null,
    };
  }

  const gaps: GapFinding[] = [
    gap(
      "response",
      slowResponse,
      fastResponse,
      "New enquiries appear to wait before a first reply.",
      "A fast first reply is already in place; coverage outside office hours can still be assessed.",
    ),
    gap(
      "followup",
      weakFollowup,
      hasFollowup,
      "Follow-up appears manual or inconsistent after the first contact.",
      "A structured follow-up routine exists; consistency can still be automated.",
    ),
    gap(
      "qualification",
      manualQualification,
      null,
      "Qualification and repetitive questions consume sales-team time.",
      "",
    ),
    gap(
      "automation",
      noAutomation,
      hasAutomation,
      "Core enquiry handling appears to run without automation support.",
      "Some tooling exists; workflows can still be coordinated end to end.",
    ),
    gap(
      "prioritisation",
      noPrioritisation,
      hasPrioritisation,
      "High-intent prospects are not consistently identified and prioritised.",
      "Some prioritisation exists; scoring can be made deterministic and explainable.",
    ),
  ];

  const state: CurrentState[] = [
    { label: "Lead volume", value: volume ?? NOT_PROVIDED },
    { label: "Sales consultants", value: team ?? NOT_PROVIDED },
    {
      label: "Response workflow",
      value: slowResponse ? "Delayed first response" : fastResponse ? "Fast first response" : TO_ASSESS,
    },
    {
      label: "Follow-up",
      value: weakFollowup ? "Manual / inconsistent" : hasFollowup ? "Structured" : TO_ASSESS,
    },
    {
      label: "Automation",
      value: noAutomation ? "Minimal" : hasAutomation ? "Partial tooling" : TO_ASSESS,
    },
  ];

  const opportunities = gaps.filter((g) => g.status === "opportunity");
  const ready = answered >= 2 && opportunities.length > 0;

  const headline = ready
    ? `Your clearest opportunity appears to be ${opportunities[0]!.label.toLowerCase().replace(" gap", "")}.`
    : null;

  const recommended: string[] = [];
  if (opportunities.some((g) => g.key === "response" || g.key === "qualification")) {
    recommended.push("whatsapp");
  }
  if (opportunities.some((g) => g.key === "prioritisation" || g.key === "qualification")) {
    recommended.push("lead_intel");
  }
  if (opportunities.some((g) => g.key === "followup" || g.key === "automation")) {
    recommended.push("orchestrator");
  }
  if (ready && recommended.length === 0) recommended.push("orchestrator");

  return { ready, answered, state, gaps, headline, recommended };
}

export type Capability = {
  key: string;
  name: string;
  role: string;
  status: "active" | "upcoming";
  /** Public workforce-card description (English). */
  description?: string;
  /** Public workforce-card description (Bahasa Melayu). */
  descriptionMs?: string;
};

/** Only capabilities that exist in the product are marked active. */
export const CAPABILITIES: Capability[] = [
  {
    key: "whatsapp",
    name: "AI WhatsApp Executive",
    role: "Enquiries, conversation and qualification",
    status: "active",
  },
  {
    key: "lead_intel",
    name: "AI Lead Intelligence",
    role: "Lead scoring and prioritisation",
    status: "active",
  },
  {
    key: "orchestrator",
    name: "Autonomous AI Business Executive™",
    role: "Prioritisation, next action and coordination",
    status: "active",
  },
  {
    key: "marketing",
    name: "AI Marketing Executive",
    role: "Campaign support",
    status: "active",
  },
  {
    key: "content",
    name: "AI Content Executive",
    role: "Content generation",
    status: "active",
  },
  {
    key: "sales_elite",
    name: "AI SALES ELITE™",
    role: "Elite sales intelligence, objection handling and closing",
    status: "active",
    description:
      "World-class AI sales intelligence and closing engine designed to understand customers, build trust, handle objections and guide qualified prospects toward the right next step.",
    descriptionMs:
      "Enjin kecerdasan jualan AI kelas dunia yang diformat untuk memahami pelanggan, membina kepercayaan, menangani bantahan dan membimbing prospek berkelayakan ke langkah seterusnya yang tepat.",
  },
  {
    key: "quotation",
    name: "AI Quotation Executive",
    role: "Quotation preparation",
    status: "upcoming",
  },
  {
    key: "followup",
    name: "AI Follow-up Executive",
    role: "Dedicated follow-up worker",
    status: "upcoming",
  },
  {
    key: "success",
    name: "AI Customer Success Executive",
    role: "Post-booking care",
    status: "upcoming",
  },
  {
    key: "insights",
    name: "AI Business Insights",
    role: "Executive reporting",
    status: "upcoming",
  },
];

export const EXECUTION_FLOW = [
  "New enquiry",
  "AI WhatsApp Executive — understand customer",
  "Qualify",
  "AI Lead Intelligence — prioritise",
  "Autonomous AI Business Executive™ — decide next action",
  "Follow-up or escalation",
  "Human sales team",
];

/** RAIŌ — the executive persona of UMRAIO's Autonomous AI Business Executive™. */
export const OPENING_MESSAGE =
  "Assalamualaikum. I'm RAIŌ — UMRAIO's Autonomous AI Business Executive™.\n\nTell me how your agency currently handles enquiries, sales and follow-up.\n\nI'll help you identify where your biggest opportunities are and show you how UMRAIO can help.";

export const OPENING_MESSAGE_MS =
  "Assalamualaikum. Saya RAIŌ — Autonomous AI Business Executive™ daripada UMRAIO.\n\nCeritakan bagaimana agensi Dato' menguruskan enquiry, sales dan follow-up sekarang.\n\nSaya akan bantu kenal pasti peluang terbesar dan tunjukkan bagaimana UMRAIO boleh membantu.";

export type MeetLanguagePreference = "auto" | "ms" | "en";

