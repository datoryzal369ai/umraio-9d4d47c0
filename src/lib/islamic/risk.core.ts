/**
 * ISLAMIC IMPLEMENTATION LAYER™ V2.4 — pragmatic human-escalation model.
 *
 * Governance, not censorship. Human experts are an ESCALATION path, not a
 * gate in front of every Islamic question.
 *
 *   BASIC      → established educational knowledge. Answer now. No review. Voice ok.
 *   GUIDANCE   → ordinary established guidance with a short qualification. No review. Voice ok.
 *   SENSITIVE  → case-specific. Limited general explanation allowed; escalate only
 *                when the answer genuinely depends on individual judgement.
 *   HIGH_RISK  → fatwa / consequential determination / personal validity. Mandatory
 *                human review of an AI-generated draft.
 *
 * The classifier weighs INTENT + COMPLEXITY + CONSEQUENCE + PERSONAL CONTEXT.
 * Keyword presence alone ("hukum", "Islam", "doa", "Umrah", "tawaf", "ihram",
 * "masjid") NEVER escalates.
 *
 * Nothing here issues a religious ruling.
 */

import { detectReligiousRulingRequest } from "./policy.core";

export const ISLAMIC_RISK_TIERS = ["BASIC", "GUIDANCE", "SENSITIVE", "HIGH_RISK"] as const;
export type IslamicRiskTier = (typeof ISLAMIC_RISK_TIERS)[number];

export type IslamicRiskClassification = {
  /** `null` when the message is not an Islamic/religious question at all. */
  tier: IslamicRiskTier | null;
  reason: string;
  matchedOn: string | null;
};

const NOT_RELIGIOUS: IslamicRiskClassification = {
  tier: null,
  reason: "no_religious_intent",
  matchedOn: null,
};

/* ------------------------------------------------------------------ */
/* Signals                                                              */
/* ------------------------------------------------------------------ */

/** Explicit demand for a formal religious ruling from an authority. */
const FATWA_PATTERNS: Array<[RegExp, string]> = [
  [/\bfatwa\b/i, "fatwa_request"],
  [/\b(mufti|majlis\s+fatwa|jakim)\b[^.?!]{0,40}\b(kata|hukum|ruling|semak|putus)\b/i, "authority_ruling_request"],
  [/\b(islamic|religious|shariah|syariah)\s+(ruling|verdict|judgement|judgment)\b/i, "ruling_request"],
];

/** Domains where a wrong answer has legal / financial / family consequences. */
const HIGH_CONSEQUENCE_DOMAINS: Array<[RegExp, string]> = [
  [/\b(talaq|talak|cerai|perceraian|rujuk\s+semula)\b/i, "family_law"],
  [/\b(faraid|pusaka|warisan|inheritance)\b/i, "inheritance"],
  [/\b(riba|riba')\b/i, "financial_ruling"],
  [/\b(nikah|perkahwinan)\b[^.?!]{0,40}\b(sah|batal|hukum)\b/i, "family_law"],
];

/** Determination language: asking for a definitive religious verdict. */
const DETERMINATION = /\b(sah|tidak\s+sah|batal|terbatal|wajib|haram|halal|makruh|harus)\b/i;
const HALAL_HARAM_DETERMINATION = /\b(halal|haram)\s+(atau|ke|tak|atau\s+tidak)\b/i;
const EXPIATION = /\b(dam|fidyah|kafarah|kaffarah)\b/i;

/** The customer is asking about themselves or their own household. */
const PERSONAL_CONTEXT =
  /\b(saya|aku|kami|isteri|suami|anak|ibu|ayah|keadaan\s+saya|kes\s+saya|my|i\s+(am|was|have|did))\b/i;

/** The answer depends materially on facts of what happened. */
const CASE_MARKERS =
  /\b(terlupa|tertinggal|tersilap|tak\s+sengaja|tidak\s+sengaja|sengaja|dalam\s+keadaan|kerana|sebab|sedang|semasa\s+haid|haid|uzur|sakit|jika\s+saya|kalau\s+saya|selepas\s+saya)\b/i;

/** Ruling-shaped questions ("apa hukum…", "boleh atau tidak"). Risk depends on context. */
const RULING_SHAPE: Array<[RegExp, string]> = [
  [/\b(apa|apakah|nak\s+tahu|minta)\s*(kan)?\s*hukum(nya)?\b/i, "hukum_question"],
  [/\bhukum\s+(nya|bagi|untuk|kalau|jika|melakukan|guna|pakai|bayar|memakai)\b/i, "hukum_question"],
  [/\b(boleh|sah)\s*(ke|kah|tak|atau\s+tidak|atau\s+tak)\b/i, "permissibility_question"],
  [/\b(adakah|apakah|is|are)\b[^.?!]{0,80}\b(sah|tidak\s+sah|batal|wajib|haram|makruh)\b/i, "validity_question"],
  [/\bmahram\b[^.?!]{0,40}\b(wajib|perlu|mesti|hukum|sah)\b/i, "mahram_question"],
];

/* ------------------------------------------------------------------ */
/* BASIC — established educational knowledge                            */
/* ------------------------------------------------------------------ */

const BASIC_PATTERNS: Array<[RegExp, string]> = [
  [/\brukun\s+(islam|iman|umrah|haji)\b/i, "rukun_definition"],
  [
    /\b(apa|apakah|apa\s+itu|maksud|makna|erti|ertinya|terjemahan|meaning)\b[^.?!]{0,60}\b(talbiyah|talbiah|ihram|tawaf|sa'?i|saie|miqat|umrah|doa|zikir|bacaan|tahallul|dam)\b/i,
    "terminology_definition",
  ],
  [
    /\b(talbiyah|talbiah|ihram|tawaf|sa'?i|saie|miqat|umrah|doa|zikir|bacaan)\b[^.?!]{0,60}\b(apa|maksud|makna|ertinya|terjemahan|meaning)\b/i,
    "terminology_definition",
  ],
  [/\b(urutan|langkah|step|cara\s+asas|proses)\b[^.?!]{0,40}\b(tawaf|sa'?i|saie|umrah|ihram)\b/i, "sequence_education"],
  [/\b(apa|apakah)\s+doa\b/i, "supplication_education"],
  [/\bdoa\b[^.?!]{0,40}\b(dibaca|baca|ketika|semasa|masa)\b/i, "supplication_education"],
  [/\badab\b/i, "etiquette_education"],
  [/\bpersediaan\b[^.?!]{0,40}\b(umrah|haji|ibadah)\b/i, "preparation_education"],
];

/* ------------------------------------------------------------------ */
/* GUIDANCE — contextual but non-ruling                                 */
/* ------------------------------------------------------------------ */

const GUIDANCE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(mazhab|madhhab|perbezaan|berbeza)\b/i, "practice_variation"],
  [/\b(biasanya|kebiasaan|amalan)\b[^.?!]{0,40}\b(umrah|ibadah|masjid)\b/i, "practice_guidance"],
  [/\b(islam|islamic|syariah|shariah|agama|ibadah|masjid|umrah|tawaf|ihram|doa)\b/i, "religious_topic"],
];

function firstMatch(
  patterns: Array<[RegExp, string]>,
  text: string,
): { reason: string; matchedOn: string } | null {
  for (const [re, reason] of patterns) {
    const hit = re.exec(text);
    if (hit) return { reason, matchedOn: hit[0].slice(0, 60) };
  }
  return null;
}

/**
 * Server-authoritative four-level classification (V2.4).
 */
export function classifyIslamicRisk(text: string | null | undefined): IslamicRiskClassification {
  const raw = (text ?? "").trim();
  if (!raw) return NOT_RELIGIOUS;

  /* 1. Explicit fatwa / authority ruling request — always HIGH_RISK. */
  const fatwa = firstMatch(FATWA_PATTERNS, raw);
  if (fatwa) return { tier: "HIGH_RISK", reason: fatwa.reason, matchedOn: fatwa.matchedOn };

  /* 2. High-consequence legal / financial / family domains. */
  const domain = firstMatch(HIGH_CONSEQUENCE_DOMAINS, raw);
  if (domain) return { tier: "HIGH_RISK", reason: domain.reason, matchedOn: domain.matchedOn };

  const personal = PERSONAL_CONTEXT.test(raw);
  const caseSpecific = CASE_MARKERS.test(raw);
  const determination = DETERMINATION.test(raw);
  const ruling = firstMatch(RULING_SHAPE, raw);

  /* 3. Personal validity / expiation with real consequences. */
  const halalHaram = HALAL_HARAM_DETERMINATION.exec(raw);
  if (halalHaram) {
    return {
      tier: "HIGH_RISK",
      reason: "halal_haram_determination",
      matchedOn: halalHaram[0].slice(0, 60),
    };
  }
  const expiation = EXPIATION.exec(raw);
  if (expiation && (personal || caseSpecific)) {
    return { tier: "HIGH_RISK", reason: "expiation_case", matchedOn: expiation[0] };
  }
  if (personal && caseSpecific && (determination || !!ruling)) {
    return { tier: "HIGH_RISK", reason: "personal_validity_case", matchedOn: ruling?.matchedOn ?? "personal_case" };
  }
  if (personal && determination) {
    return { tier: "HIGH_RISK", reason: "personal_validity_case", matchedOn: ruling?.matchedOn ?? "personal_case" };
  }

  /* 4. Established educational knowledge beats ruling-shaped phrasing. */
  const basic = firstMatch(BASIC_PATTERNS, raw);
  if (basic && !ruling) return { tier: "BASIC", reason: basic.reason, matchedOn: basic.matchedOn };

  /* 5. Case-specific but impersonal, or expiation in the abstract → SENSITIVE. */
  if (expiation) return { tier: "SENSITIVE", reason: "expiation_topic", matchedOn: expiation[0] };
  if (ruling && (caseSpecific || personal)) {
    return { tier: "SENSITIVE", reason: "case_specific_question", matchedOn: ruling.matchedOn };
  }
  if (ruling && /\b(melakukan|buat|perkara\s+ini|benda\s+ni|situasi)\b/i.test(raw)) {
    return { tier: "SENSITIVE", reason: "unspecified_act_question", matchedOn: ruling.matchedOn };
  }

  /* 6. Ordinary "hukum"/permissibility question about an established matter. */
  if (ruling) {
    return { tier: "GUIDANCE", reason: "ordinary_ruling_question", matchedOn: ruling.matchedOn };
  }
  if (basic) return { tier: "BASIC", reason: basic.reason, matchedOn: basic.matchedOn };

  const legacyRuling = detectReligiousRulingRequest(raw);
  if (legacyRuling.isReligiousRulingRequest) {
    return { tier: "SENSITIVE", reason: "ruling_request", matchedOn: legacyRuling.matchedOn };
  }

  const guidance = firstMatch(GUIDANCE_PATTERNS, raw);
  if (guidance) return { tier: "GUIDANCE", reason: guidance.reason, matchedOn: guidance.matchedOn };

  return NOT_RELIGIOUS;
}

/** Only HIGH_RISK mandates an Islamic review. */
export function requiresIslamicReview(tier: IslamicRiskTier | null): boolean {
  return tier === "HIGH_RISK";
}

/**
 * Tiers that are ALLOWED to open a review. SENSITIVE may escalate when the
 * model judges the answer to need individual religious judgement; BASIC and
 * GUIDANCE may never escalate.
 */
export function mayEscalateIslamicReview(tier: IslamicRiskTier | null): boolean {
  return tier === "HIGH_RISK" || tier === "SENSITIVE";
}

/** Human-facing escalation label for the expert review queue. */
export function islamicRiskLabel(tier: IslamicRiskTier | null): string {
  if (tier === "HIGH_RISK") return "HIGH-RISK · FATWA / CASE-SPECIFIC";
  if (tier === "SENSITIVE") return "SENSITIVE · CASE-SPECIFIC";
  if (tier === "GUIDANCE") return "GUIDANCE";
  if (tier === "BASIC") return "BASIC";
  return "UNCLASSIFIED";
}

/* ------------------------------------------------------------------ */
/* Prompt fragments per tier                                            */
/* ------------------------------------------------------------------ */

const BASIC_INSTRUCTION = [
  "ISLAMIC RISK TIER = BASIC (Islamic Implementation Layer™ V2.4).",
  "This is established, educational Islamic knowledge. Answer it NOW, directly and warmly, using approved knowledge (search_knowledge) or well-established general Islamic knowledge such as the Rukun Islam, Rukun Iman, the meaning of Talbiyah, ihram, tawaf, sa'i, common supplications and masjid etiquette.",
  "Do NOT call request_expert_review. Do NOT say the question is with a religious advisor. Do NOT ask the customer to wait. Do NOT open any review.",
  "Do not invent details and do not issue a personal ruling. If the specific detail is genuinely not established or not in approved knowledge, say so plainly and offer to have it verified — without promising a review you did not request.",
].join(" ");

const GUIDANCE_INSTRUCTION = [
  "ISLAMIC RISK TIER = ORDINARY GUIDANCE (Islamic Implementation Layer™ V2.4).",
  "This is an ordinary, established matter. Answer it directly from approved knowledge with one short qualification such as 'Secara umum…' or 'Menurut panduan yang dirujuk…', and note that for a specific personal situation a qualified religious guide can verify.",
  "Do NOT call request_expert_review and do NOT tell the customer to wait. Never claim to be a mufti, scholar or Shariah authority, and never present the answer as an official fatwa.",
  "If approved knowledge does not cover it, say so honestly instead of inventing an answer.",
].join(" ");

const SENSITIVE_INSTRUCTION = [
  "ISLAMIC RISK TIER = SENSITIVE / CASE-SPECIFIC (Islamic Implementation Layer™ V2.4).",
  "You may give a limited, clearly general explanation ('Secara umum…') where approved knowledge supports it, without declaring anything definitively sah, batal, wajib, haram or makruh for this person.",
  "Only if the answer genuinely depends on the customer's individual circumstances or a disputed position, call request_expert_review ONCE with a proposed draft answer, then continue helping with the travel side. Otherwise answer and do not open a review.",
].join(" ");

const HIGH_RISK_INSTRUCTION = [
  "ISLAMIC RISK TIER = HIGH_RISK (Islamic Implementation Layer™ V2.4, highest priority).",
  "The customer is asking for a formal ruling or a judgement with real religious, legal or financial consequences. You are NOT a mufti, scholar, fatwa body or Shariah authority. Never issue the ruling and never state that something is definitively halal, haram, wajib, sunat, makruh, sah or batal.",
  "Send ONE concise holding response, for example: 'Baik Datuk. Soalan ini melibatkan hukum dan keadaan khusus, jadi saya akan dapatkan semakan daripada pembimbing agama bertauliah terlebih dahulu. Saya tidak akan memberikan hukum yang belum disahkan.'",
  "Then call request_expert_review ONCE, and always include your best structured draft answer plus the approved sources you relied on so the human expert can approve, amend or reject it. Continue helping with the travel side. Never repeat this holding message on later messages.",
].join(" ");

export function islamicRiskInstruction(tier: IslamicRiskTier | null): string | null {
  if (tier === "BASIC") return BASIC_INSTRUCTION;
  if (tier === "GUIDANCE") return GUIDANCE_INSTRUCTION;
  if (tier === "SENSITIVE") return SENSITIVE_INSTRUCTION;
  if (tier === "HIGH_RISK") return HIGH_RISK_INSTRUCTION;
  return null;
}
