/**
 * ISLAMIC IMPLEMENTATION LAYER™ V2.3 — risk-based classification (pure core).
 *
 * Governance, not censorship. Established basic Islamic knowledge is answered
 * directly from approved knowledge; only genuine ruling-seeking / case-specific
 * questions go to a qualified human reviewer.
 *
 *   BASIC      → answer now from approved knowledge, no review, voice allowed
 *   GUIDANCE   → answer as general guidance with qualification, no blocking review
 *   HIGH_RISK  → qualified human Islamic review (fatwa / hukum / personal case)
 *
 * Nothing here issues a religious ruling.
 */

import { detectReligiousRulingRequest } from "./policy.core";

export const ISLAMIC_RISK_TIERS = ["BASIC", "GUIDANCE", "HIGH_RISK"] as const;
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
/* HIGH_RISK — ruling requests, personal validity, consequential fiqh   */
/* ------------------------------------------------------------------ */

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\bfatwa\b/i, "fatwa_request"],
  [/\b(apa|apakah|nak\s+tahu|minta)\s*(kan)?\s*hukum(nya)?\b/i, "hukum_request"],
  [/\bhukum\s+(nya|bagi|untuk|kalau|jika|melakukan|guna|pakai|bayar)\b/i, "hukum_request"],
  [/\b(halal|haram)\s+(atau|ke|tak|atau\s+tidak)\b/i, "halal_haram_determination"],
  [/\b(sah|tidak\s+sah|batal)\s*(ke|kah|tak|atau\s+tidak)\b/i, "validity_determination"],
  [
    /\b(adakah|apakah|is|are)\b[^.?!]{0,80}\b(sah|tidak\s+sah|batal|wajib|haram|makruh)\b/i,
    "validity_determination",
  ],
  [/\b(saya|aku|kami|isteri|suami|anak)\b[^.?!]{0,80}\b(sah|batal|terlupa|tertinggal|terbatal)\b/i, "personal_case"],
  [/\b(dam|fidyah|kafarah|kaffarah)\b/i, "expiation_case"],
  [/\b(talaq|talak|cerai|perceraian)\b/i, "family_law"],
  [/\b(faraid|pusaka|warisan|inheritance)\b/i, "inheritance"],
  [/\b(riba|riba')\b/i, "financial_ruling"],
  [/\b(mufti|majlis\s+fatwa|jakim)\b[^.?!]{0,40}\b(kata|hukum|ruling|semak)\b/i, "authority_ruling_request"],
  [/\b(islamic|religious|shariah|syariah)\s+(ruling|verdict|judgement)\b/i, "ruling_request"],
  [/\bmahram\b[^.?!]{0,40}\b(wajib|perlu|mesti|hukum|sah)\b/i, "mahram_ruling"],
];

/* ------------------------------------------------------------------ */
/* BASIC — established educational knowledge                            */
/* ------------------------------------------------------------------ */

const BASIC_PATTERNS: Array<[RegExp, string]> = [
  [/\brukun\s+(islam|iman|umrah|haji)\b/i, "rukun_definition"],
  [
    /\b(apa|apakah|apa\s+itu|maksud|makna|erti|ertinya|terjemahan|meaning)\b[^.?!]{0,60}\b(talbiyah|ihram|tawaf|sa'?i|saie|miqat|umrah|doa|zikir|bacaan|tahallul|dam)\b/i,
    "terminology_definition",
  ],
  [
    /\b(talbiyah|ihram|tawaf|sa'?i|saie|miqat|umrah|doa|zikir|bacaan)\b[^.?!]{0,60}\b(apa|maksud|makna|ertinya|terjemahan|meaning)\b/i,
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
 * Server-authoritative three-tier classification. Keyword presence alone never
 * escalates: intent + risk decide the tier.
 */
export function classifyIslamicRisk(text: string | null | undefined): IslamicRiskClassification {
  const raw = (text ?? "").trim();
  if (!raw) return NOT_RELIGIOUS;

  const high = firstMatch(HIGH_RISK_PATTERNS, raw);
  if (high) return { tier: "HIGH_RISK", reason: high.reason, matchedOn: high.matchedOn };

  const basic = firstMatch(BASIC_PATTERNS, raw);
  if (basic) return { tier: "BASIC", reason: basic.reason, matchedOn: basic.matchedOn };

  const ruling = detectReligiousRulingRequest(raw);
  if (ruling.isReligiousRulingRequest) {
    return { tier: "HIGH_RISK", reason: "ruling_request", matchedOn: ruling.matchedOn };
  }

  const guidance = firstMatch(GUIDANCE_PATTERNS, raw);
  if (guidance) return { tier: "GUIDANCE", reason: guidance.reason, matchedOn: guidance.matchedOn };

  return NOT_RELIGIOUS;
}

/** Only HIGH_RISK may open an Islamic review. */
export function requiresIslamicReview(tier: IslamicRiskTier | null): boolean {
  return tier === "HIGH_RISK";
}

/* ------------------------------------------------------------------ */
/* Prompt fragments per tier                                            */
/* ------------------------------------------------------------------ */

const BASIC_INSTRUCTION = [
  "ISLAMIC RISK TIER = BASIC (Islamic Implementation Layer™).",
  "This is established, educational Islamic knowledge. Answer it NOW, directly and warmly, using approved knowledge (search_knowledge) or well-established general Islamic knowledge such as the Rukun Islam, Rukun Iman, the meaning of Talbiyah, ihram, tawaf, sa'i, common supplications and masjid etiquette.",
  "Do NOT call request_expert_review. Do NOT say the question is with a religious advisor. Do NOT ask the customer to wait. Do NOT open any review.",
  "Do not invent details, do not issue a ruling, and do not declare anything halal, haram, wajib, sunat, makruh, sah or batal. If the specific detail is genuinely not established or not in approved knowledge, say so plainly and offer to have it verified — without promising a review you did not request.",
].join(" ");

const GUIDANCE_INSTRUCTION = [
  "ISLAMIC RISK TIER = GUIDANCE (Islamic Implementation Layer™).",
  "Answer with general, sourced guidance and one short qualification that this is general information, not a religious ruling, and that practice may differ.",
  "Do NOT open a review unless the customer explicitly asks for a definitive ruling. Keep helping with the travel side.",
].join(" ");

const HIGH_RISK_INSTRUCTION = [
  "ISLAMIC RISK TIER = HIGH_RISK (Islamic Implementation Layer™, highest priority).",
  "The customer is asking for a religious ruling or a judgement on their personal circumstances. You are NOT a mufti, scholar, fatwa body or Shariah authority. Never issue the ruling and never state that something is definitively halal, haram, wajib, sunat, makruh, sah or batal.",
  "Send ONE concise holding response, for example: 'Baik Datuk. Soalan ini melibatkan hukum dan keadaan khusus, jadi saya akan dapatkan semakan daripada pembimbing agama bertauliah terlebih dahulu. Saya tidak akan memberikan hukum yang belum disahkan.'",
  "Then call request_expert_review once, and continue helping with the travel side. Never repeat this holding message on later messages.",
].join(" ");

export function islamicRiskInstruction(tier: IslamicRiskTier | null): string | null {
  if (tier === "BASIC") return BASIC_INSTRUCTION;
  if (tier === "GUIDANCE") return GUIDANCE_INSTRUCTION;
  if (tier === "HIGH_RISK") return HIGH_RISK_INSTRUCTION;
  return null;
}
