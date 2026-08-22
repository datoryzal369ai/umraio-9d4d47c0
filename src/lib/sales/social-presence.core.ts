/**
 * UMRAIO® STEP 3D — HUMAN PRESENCE & SOCIAL INTELLIGENCE ENGINE™
 *
 * Deterministic, additive social layer. It does not decide sales strategy
 * (Step 3.7 behavioural engine), conversation state (Step 3) or conversion
 * state (Step 3C). It only derives HOW RAIŌ should speak: who it is talking
 * to, what to call them, how formal to be, and which empathy signals need
 * acknowledgement before anything commercial happens.
 *
 * Pure functions only — no I/O, no model calls, no schema changes.
 */

import { detectMessageLanguage, type LanguageCode } from "./conversation-intelligence.core";
import { normalizeMessage } from "./hardening.core";

export type SocialMessage = { sender: "customer" | "ai" | "human" | string; body: string };

/* ------------------------------------------------------------------ */
/* Honorific intelligence                                              */
/* ------------------------------------------------------------------ */

/** Malaysian forms of address RAIŌ may use. Never invented, only echoed. */
export const HONORIFICS = [
  "Dato' Seri",
  "Datin Seri",
  "Dato'",
  "Datuk",
  "Datin",
  "Tuan Haji",
  "Puan Hajah",
  "Tuan Syed",
  "Puan Sri",
  "Tan Sri",
  "Ustaz",
  "Ustazah",
  "Haji",
  "Hajah",
  "Prof.",
  "Dr.",
  "Encik",
  "Puan",
  "Tuan",
  "Cik",
  "Mr.",
  "Mrs.",
  "Ms.",
] as const;

export type Honorific = (typeof HONORIFICS)[number];

const HONORIFIC_PATTERNS: Array<{ re: RegExp; value: Honorific }> = [
  { re: /\bdato'?\s+seri\b/i, value: "Dato' Seri" },
  { re: /\bdatin\s+seri\b/i, value: "Datin Seri" },
  { re: /\btan\s+sri\b/i, value: "Tan Sri" },
  { re: /\bpuan\s+sri\b/i, value: "Puan Sri" },
  { re: /\btuan\s+haji\b/i, value: "Tuan Haji" },
  { re: /\bpuan\s+hajah\b/i, value: "Puan Hajah" },
  { re: /\bdato'?\b/i, value: "Dato'" },
  { re: /\bdatuk\b/i, value: "Datuk" },
  { re: /\bdatin\b/i, value: "Datin" },
  { re: /\bustazah\b/i, value: "Ustazah" },
  { re: /\bustaz\b/i, value: "Ustaz" },
  { re: /\bhajah\b/i, value: "Hajah" },
  { re: /\bhaji\b/i, value: "Haji" },
  { re: /\bprof(\.|essor)?\b/i, value: "Prof." },
  { re: /\bdr\.?\b|\bdoktor\b/i, value: "Dr." },
  { re: /\bencik\b|\bcik\s+abang\b/i, value: "Encik" },
  { re: /\bpuan\b/i, value: "Puan" },
  { re: /\btuan\b/i, value: "Tuan" },
  { re: /\bcik\b/i, value: "Cik" },
  { re: /\bmrs\.?\b/i, value: "Mrs." },
  { re: /\bms\.?\b/i, value: "Ms." },
  { re: /\bmr\.?\b/i, value: "Mr." },
];

/** Words that must never be treated as a personal name. */
const NAME_STOPWORDS = new Set([
  "nak", "nk", "tak", "tk", "ada", "cuma", "just", "nothing", "ok", "okay", "sorry",
  "rasa", "fikir", "ingin", "mahu", "minat", "berminat", "dari", "dr", "di", "ni",
  "tu", "je", "sahaja", "sudah", "dah", "belum", "boleh", "tanya", "nanti", "pun",
  "orang", "seorang", "keluarga", "budget", "bajet", "umrah", "pakej", "package",
  "the", "a", "an", "not", "interested", "looking", "asking", "checking", "here",
  "with", "from", "and", "but", "very", "really", "still", "trying", "planning",
]);

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Honorific tokens that must be stripped out of a detected personal name. */
const HONORIFIC_TOKENS = new Set([
  "dato", "dato'", "datuk", "datin", "seri", "tan", "sri", "puan", "tuan",
  "encik", "cik", "haji", "hajah", "ustaz", "ustazah", "dr", "dr.", "doktor",
  "prof", "prof.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "syed",
]);

function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  let parts = raw
    .trim()
    .replace(/["'.,!?]+$/g, "")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z@'-]{2,}$/.test(w));
  // Strip any leading honorific tokens — the title is resolved separately and
  // must never become part of the customer's actual name.
  while (parts.length > 1 && HONORIFIC_TOKENS.has(parts[0]!.toLowerCase())) parts = parts.slice(1);
  parts = parts.slice(0, 3);
  if (parts.length === 0) return null;
  if (NAME_STOPWORDS.has(parts[0]!.toLowerCase())) return null;
  if (HONORIFIC_TOKENS.has(parts[0]!.toLowerCase())) return null;
  return parts.map(titleCase).join(" ");
}


/**
 * J2 — DECLARED identity. Only these phrasings are an explicit self-declaration
 * of how the customer wants to be known, and only these may override an
 * identity already stored on the lead.
 */
const DECLARED_NAME_PATTERNS: RegExp[] = [
  /\bnama\s+(?:penuh\s+)?(?:saya|aku|sy)\s+(?:ialah\s+|adalah\s+|is\s+)?([A-Za-z' -]{2,40})/i,
  /\b(?:boleh\s+)?panggil\s+(?:saya|sy|aku)\s+([A-Za-z' -]{2,40})/i,
  /\bsaya\s+lebih\s+suka\s+dipanggil\s+([A-Za-z' -]{2,40})/i,
  /\bcall\s+me\s+([A-Za-z' -]{2,40})/i,
  /\bmy\s+name\s+is\s+([A-Za-z' -]{2,40})/i,
];

/**
 * J1 — weaker, INFERRED patterns. `i am` / `i'm` / `this is` must be anchored on
 * real word boundaries: the previous `i\s*am` matched the substring "iam" inside
 * Malay words such as "diam" ("Kenapa diam pulak" → false name "Pulak").
 */
const NAME_PATTERNS: RegExp[] = [
  ...DECLARED_NAME_PATTERNS,
  /(?:^|[\s,;:.!?])(?:i\s+am|i'm|im|this\s+is)\s+([A-Za-z' -]{2,40})/i,
  /\b(?:[Ss]aya|[Ss]y|[Aa]ku)\s+([A-Z][A-Za-z']{1,20}(?:\s+[A-Z][A-Za-z']{1,20})?)\b/,
  /\b(?:[Ee]ncik|[Pp]uan|[Tt]uan|[Cc]ik|[Dd]ato'?|[Dd]atuk|[Dd]atin|[Hh]aji|[Hh]ajah|[Uu]staz|[Uu]stazah|[Dd]r\.?|[Mm]r\.?|[Mm]rs\.?|[Mm]s\.?)\s+([A-Z][A-Za-z']{1,20}(?:\s+[A-Z][A-Za-z']{1,20})?)\b/,
];

export type AddressReading = {
  /** Honorific explicitly used or requested by the customer, or supplied by trusted context. Never inferred from a name. */
  honorific: Honorific | null;
  /** Where the honorific came from — evidence trail, never a guess. */
  honorificSource: "self_stated" | "trusted_context" | null;
  /** Name the customer gave for themselves. */
  name: string | null;
  /** Preferred nickname when the customer asked for a shorter form. */
  preferredName: string | null;
  /** True when the customer asked to be called by a plain name only ("panggil saya Rizal sahaja"). */
  honorificDeclined: boolean;
  confidence: "CONFIRMED" | "PARTIAL" | "UNKNOWN";
  /** Ready-to-use form of address, e.g. "Encik Ahmad". Null when unknown. */
  addressForm: string | null;
  /** True when RAIŌ should politely ask how to address the customer. */
  shouldAskHowToAddress: boolean;
};

export function detectSelfName(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const re of NAME_PATTERNS) {
    const m = re.exec(text);
    const cleaned = cleanName(m?.[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * J2 — an explicit self-declaration ("Nama saya Ahmad", "Panggil saya Ahmad",
 * "My name is Ahmad"). Only this may override an identity already stored on the
 * lead; everything else is a weak inference.
 */
export function detectDeclaredName(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const re of DECLARED_NAME_PATTERNS) {
    const m = re.exec(text);
    const cleaned = cleanName(m?.[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

export function detectHonorific(text: string | null | undefined): Honorific | null {
  if (!text) return null;
  for (const p of HONORIFIC_PATTERNS) if (p.re.test(text)) return p.value;
  return null;
}

/**
 * Honorific the customer applied to THEMSELVES. Only self-referential phrasing
 * counts ("Saya Dato' Rizal", "Nama saya Tuan Haji Ahmad", or a bare
 * "Dato' Rizal" introduction). A title mentioned about someone else never does.
 */
export function detectSelfHonorific(text: string | null | undefined): Honorific | null {
  if (!text) return null;
  const trimmed = text.trim();
  const selfIntro =
    /(?:nama\s+(?:saya|aku|sy)(?:\s+(?:ialah|adalah))?|saya|sy|aku|panggil\s+saya|call\s+me|my\s+name\s+is|i\s*am|i'?m|this\s+is)\s+(.{0,40})/i.exec(
      trimmed,
    );
  if (selfIntro?.[1]) {
    const h = detectHonorific(selfIntro[1]);
    if (h) return h;
  }
  // Bare introduction, e.g. "Dato' Rizal" as the whole message.
  if (trimmed.split(/\s+/).length <= 4) {
    const h = detectHonorific(trimmed);
    if (h) return h;
  }
  return null;
}

/**
 * Resolves how the customer should be addressed, from the conversation, a
 * trusted stored honorific and any name already on the lead. Never invents a
 * title and never changes the name the customer actually gave.
 */
export function resolveAddress(input: {
  customerMessages: string[];
  knownName?: string | null;
  /** Honorific already verified in trusted context (e.g. stored on the lead). */
  trustedHonorific?: Honorific | string | null;
  turnCount?: number;
}): AddressReading {
  let honorific: Honorific | null = null;
  let honorificSource: AddressReading["honorificSource"] = null;
  let name: string | null = null;
  let preferredName: string | null = null;
  let honorificDeclined = false;

  for (const raw of input.customerMessages) {
    const h = detectSelfHonorific(raw);
    if (h) {
      honorific = h;
      honorificSource = "self_stated";
    }
    // J2 — IDENTITY PRECEDENCE. A stored identity is authoritative; only an
    // explicit declaration ("Nama saya…", "Panggil saya…", "My name is…") may
    // replace it. Weak conversational inference never overrides stored data.
    const declared = detectDeclaredName(raw);
    if (declared) {
      name = declared;
      declaredName = declared;
    } else if (!input.knownName) {
      const n = detectSelfName(raw);
      if (n) name = n;
    }
    const short =
      /(?:panggil\s+(?:saya|sy)|call\s+me|just\s+call\s+me)\s+([A-Za-z']{2,20})(\s*(?:sahaja|saja|je|jer|only))?/i.exec(
        raw,
      );
    const shortName = cleanName(short?.[1]);
    if (shortName) {
      preferredName = shortName;
      if (short?.[2]) honorificDeclined = true;
    }
  }

  if (!honorific && input.trustedHonorific) {
    const trusted = HONORIFICS.find(
      (h) => h.toLowerCase() === String(input.trustedHonorific).trim().toLowerCase(),
    );
    if (trusted) {
      honorific = trusted;
      honorificSource = "trusted_context";
    }
  }

  if (!name && input.knownName) name = cleanName(input.knownName);

  const display = preferredName ?? name;
  const useHonorific = honorific && !honorificDeclined ? honorific : null;
  const addressForm = display
    ? useHonorific
      ? `${useHonorific} ${display}`
      : display
    : useHonorific
      ? useHonorific
      : null;

  const confidence: AddressReading["confidence"] = display && useHonorific
    ? "CONFIRMED"
    : display || useHonorific
      ? "PARTIAL"
      : "UNKNOWN";

  return {
    honorific,
    honorificSource,
    name,
    preferredName,
    honorificDeclined,
    confidence,
    addressForm,
    shouldAskHowToAddress: confidence === "UNKNOWN",
  };
}


/* ------------------------------------------------------------------ */
/* Register, pacing and mirroring                                      */
/* ------------------------------------------------------------------ */

export type SocialRegister = "formal" | "professional" | "casual";
export type SocialPacing = "measured" | "natural" | "brisk";

const CASUAL_MARKERS =
  /\b(hi|hai|hey|boss|bro|sis|lah|lor|meh|je|jer|kot|weh|ha ah|okla|okey|ok la|tq|thanks|thx|nak tanya|cam ne|camne|macam ne)\b/i;
const FORMAL_MARKERS =
  /\b(assalamualaikum|salam sejahtera|tuan|puan|yang berbahagia|mohon|sukacita|dimaklumkan|kindly|regards|sekian|terima kasih di atas)\b/i;
const SHORTFORM_MARKERS = /\b(sy|tk|tq|dgn|utk|brp|nk|dh|blh|xnak|x nak|pls|plz)\b/i;

export type SocialSignal =
  | "EXCITEMENT"
  | "UNCERTAINTY"
  | "FEAR"
  | "HESITATION"
  | "CONFUSION"
  | "URGENCY"
  | "DISAPPOINTMENT"
  | "ANXIETY"
  | "TRUST_CONCERN"
  | "FAMILY_CONCERN"
  | "ELDERLY_TRAVELLER"
  | "FINANCIAL_CONCERN"
  | "FIRST_TIME";

const SIGNAL_PATTERNS: Array<{ signal: SocialSignal; re: RegExp; empathy: string }> = [
  {
    signal: "EXCITEMENT",
    re: /(teruja|excited|tak sabar|alhamdulillah|best nya|bestnya|finally|dah lama impikan)/i,
    empathy: "Share the customer's happiness briefly and sincerely before any business detail.",
  },
  {
    signal: "UNCERTAINTY",
    re: /(tak pasti|tidak pasti|belum pasti|not sure|unsure|entah|maybe|mungkin lah|masih fikir)/i,
    empathy: "Reduce the number of choices and make the next step small and easy.",
  },
  {
    signal: "FEAR",
    re: /(takut|risau sangat|worried|scared|bimbang)/i,
    empathy: "Name the worry back plainly, then answer it with verified facts only.",
  },
  {
    signal: "HESITATION",
    re: /(nak fikir dulu|fikir dulu|think about it|later dulu|nanti saya balas|tengok dulu)/i,
    empathy:
      "Do not push. Acknowledge the pause, then ask gently what is still unresolved (price, hotel, dates, family decision).",
  },
  {
    signal: "CONFUSION",
    re: /(keliru|confuse|confused|tak faham|x faham|susah faham|apa maksud)/i,
    empathy: "Slow down, explain one thing at a time in plain words, no jargon.",
  },
  {
    signal: "URGENCY",
    re: /(urgent|segera|cepat|kena settle|this week|minggu ni|dah dekat|last minute)/i,
    empathy: "Match the urgency with a clear, immediate next step — never manufacture pressure.",
  },
  {
    signal: "DISAPPOINTMENT",
    re: /(kecewa|disappointed|sedih|frustrated dengan agensi|dulu kena tipu)/i,
    empathy: "Acknowledge the bad past experience honestly and do not defend anyone.",
  },
  {
    signal: "ANXIETY",
    re: /(gelisah|anxious|stress|tak tenang|susah tidur)/i,
    empathy: "Be calm and steady. Short sentences. One reassurance, one small next step.",
  },
  {
    signal: "TRUST_CONCERN",
    re: /(scam|penipu|tipu|fraud|selamat ke|betul ke|boleh percaya|trust|legit)/i,
    empathy:
      "Agree that caution is right, then offer verifiable information only. Never invent verification, certification or proof.",
  },
  {
    signal: "FAMILY_CONCERN",
    re: /(keluarga|isteri|suami|anak|ibu|mak|ayah|bapa|parents|family|adik|abang|kakak)/i,
    empathy: "Treat the trip as a family decision: comfort, rooming and pacing matter, not only price.",
  },
  {
    signal: "ELDERLY_TRAVELLER",
    re: /(dah tua|warga emas|orang tua|elderly|kurang sihat|wheelchair|kerusi roda|susah berjalan|penat berjalan)/i,
    empathy:
      "Prioritise walking distance, comfort and rest, and say plainly that price should not be the only factor.",
  },
  {
    signal: "FINANCIAL_CONCERN",
    re: /(mahal|tak mampu|ketat|budget kecil|ansuran|installment|bayar sikit|kena jimat|duit tak cukup)/i,
    empathy: "Never shame the budget. Work within it and be transparent about what it can realistically cover.",
  },
  {
    signal: "FIRST_TIME",
    re: /(first time|kali pertama|pertama kali|belum pernah pergi|tak pernah umrah)/i,
    empathy: "Explain the journey step by step and expect basic questions without making them feel naive.",
  },
];

export function detectSocialSignals(text: string | null | undefined): SocialSignal[] {
  if (!text) return [];
  const n = normalizeMessage(text);
  const out: SocialSignal[] = [];
  for (const p of SIGNAL_PATTERNS) if (p.re.test(n) && !out.includes(p.signal)) out.push(p.signal);
  return out;
}

/** "Are you a real person?" — must be answered honestly, once, without a lecture. */
export function detectHumanIdentityQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const n = normalizeMessage(text);
  return /(ni (ai|bot|robot|mesin)|awak (ai|bot|robot)|you (a|an) (ai|bot|robot)|are you (human|real|a person|a bot|ai)|manusia ke|orang ke|robot ke|auto reply ke|chatbot ke)/i.test(
    n,
  );
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Islamic adab — contextual, never mechanical                         */
/* ------------------------------------------------------------------ */

/**
 * Moments where an Islamic expression is natural for a Malaysian Umrah
 * business conversation. Nothing here forces a phrase; it only marks where
 * one would be welcome so RAIŌ never sprinkles them as filler.
 */
export type AdabOpening =
  | "RETURN_SALAM"
  | "OFFER_HELP"
  | "FORWARD_PLAN"
  | "GOOD_NEWS"
  | "REASSURANCE"
  | "GRATITUDE";

const SALAM_RE = /\b(assalamualaikum|assalamu'?alaikum|salam(?:\s+sejahtera)?|as-?salam)\b/i;

const ADAB_PATTERNS: Array<{ opening: AdabOpening; re: RegExp }> = [
  {
    opening: "OFFER_HELP",
    re: /(boleh bantu|tolong|help me|need help|nak tanya|minta bantuan|advise|nasihat)/i,
  },
  {
    opening: "FORWARD_PLAN",
    re: /(next step|langkah seterusnya|kita mula|start|nak buat|plan|rancang|proceed|teruskan)/i,
  },
  {
    opening: "GOOD_NEWS",
    re: /(dah settle|sudah settle|alhamdulillah|good news|berjaya|naik|meningkat|dah ok|dah jalan)/i,
  },
  {
    opening: "REASSURANCE",
    re: /(risau|bimbang|takut|worried|tak pasti|not sure|susah|stress|slow|merudum|menurun|drop)/i,
  },
  { opening: "GRATITUDE", re: /(terima kasih|thanks|thank you|tq|appreciate)/i },
];

export function detectSalam(text: string | null | undefined): boolean {
  if (!text) return false;
  return SALAM_RE.test(normalizeMessage(text));
}

/** Contextual adab openings present in the customer's latest message. */
export function detectAdabOpenings(text: string | null | undefined): AdabOpening[] {
  if (!text) return [];
  const n = normalizeMessage(text);
  const out: AdabOpening[] = [];
  if (SALAM_RE.test(n)) out.push("RETURN_SALAM");
  for (const p of ADAB_PATTERNS) if (p.re.test(n) && !out.includes(p.opening)) out.push(p.opening);
  return out;
}



export type SocialProfile = {
  address: AddressReading;
  language: LanguageCode;
  register: SocialRegister;
  pacing: SocialPacing;
  usesEmoji: boolean;
  usesShortForms: boolean;
  /** Average customer message length in words — drives reply length mirroring. */
  averageWords: number;
  signals: SocialSignal[];
  empathyNotes: string[];
  humanIdentityQuestion: boolean;
  isFirstTurn: boolean;
  /** True at first contact when RAIŌ still does not know who it is speaking to. */
  needsIntroduction: boolean;
  /** Facts already stated by the customer that must never be re-asked. */
  rememberedFacts: string[];
  /** True when the customer opened with salam — the reply must return it. */
  greetedWithSalam: boolean;
  /** Where an Islamic expression would land naturally in this turn, if anywhere. */
  adabOpenings: AdabOpening[];
};

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;


export function buildSocialProfile(input: {
  messages: SocialMessage[];
  knownName?: string | null;
  /** Honorific already verified in trusted context (lead record, CRM). */
  knownHonorific?: string | null;
  knownFacts?: Record<string, string | number | null | undefined>;
}): SocialProfile {
  const customer = input.messages.filter((m) => m.sender === "customer").map((m) => m.body ?? "");
  const recent = customer.slice(-6);
  const last = customer[customer.length - 1] ?? "";

  const words = recent.map((t) => t.trim().split(/\s+/).filter(Boolean).length);
  const averageWords = words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : 0;

  const joined = recent.join(" \n ");
  const casual = CASUAL_MARKERS.test(joined);
  const formal = FORMAL_MARKERS.test(joined);
  const register: SocialRegister = formal && !casual ? "formal" : casual ? "casual" : "professional";

  const usesShortForms = SHORTFORM_MARKERS.test(joined);
  const usesEmoji = EMOJI_RE.test(joined);

  const signals: SocialSignal[] = [];
  for (const text of recent) {
    for (const s of detectSocialSignals(text)) if (!signals.includes(s)) signals.push(s);
  }
  const empathyNotes = SIGNAL_PATTERNS.filter((p) => signals.includes(p.signal)).map((p) => p.empathy);

  const pacing: SocialPacing =
    signals.includes("ELDERLY_TRAVELLER") || signals.includes("CONFUSION") || register === "formal"
      ? "measured"
      : averageWords > 0 && averageWords <= 6 && (usesShortForms || register === "casual")
        ? "brisk"
        : "natural";

  const rememberedFacts: string[] = [];
  for (const [key, value] of Object.entries(input.knownFacts ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    rememberedFacts.push(`${key} = ${value}`);
  }

  const address = resolveAddress({
    customerMessages: customer,
    knownName: input.knownName ?? null,
    trustedHonorific: input.knownHonorific ?? null,
    turnCount: customer.length,
  });

  return {
    address,
    needsIntroduction: customer.length <= 2 && address.confidence === "UNKNOWN",

    language: detectMessageLanguage(last)?.language ?? detectMessageLanguage(joined)?.language ?? "ms",
    register,
    pacing,
    usesEmoji,
    usesShortForms,
    averageWords,
    signals,
    empathyNotes,
    humanIdentityQuestion: detectHumanIdentityQuestion(last),
    isFirstTurn: customer.length <= 1,
    rememberedFacts,
    greetedWithSalam: detectSalam(last) || detectSalam(joined),
    adabOpenings: detectAdabOpenings(last),

  };
}

/* ------------------------------------------------------------------ */
/* Instruction builder                                                 */
/* ------------------------------------------------------------------ */

const ANDA_RULE =
  'FORM OF ADDRESS: "anda" is NOT the default in Malaysian conversational sales — avoid it. Use the customer\'s own form of address ("Encik nak yang mana satu?", "Untuk perjalanan puan...", "Kalau ikut keperluan tuan...") or an implicit subject ("Saya boleh bantu semak."). Use "anda" only in neutral general copy.';

const NO_CHATBOT_RULE =
  'NO CHATBOT PATTERNS: never open with "Terima kasih atas pertanyaan anda", "Sudah tentu! Saya sedia membantu anda", "Berikut adalah...", "Untuk makluman anda", "Sebagai AI...". No brochure Malay, no FAQ voice, no corporate padding.';

const IDENTITY_RULE =
  "AI IDENTITY: never claim to be human. If asked directly, answer once, briefly and warmly, then continue the conversation normally. Do not repeat AI disclaimers unprompted.";

/**
 * Human presence instruction injected into the system prompt.
 * Deterministic text — the model receives guidance, never fabricated facts.
 */
export function socialPresenceInstruction(profile: SocialProfile): string {
  const lines: string[] = [
    "HUMAN PRESENCE & SOCIAL INTELLIGENCE (highest conversational priority):",
    "NEVER open any reply with 'Hai', 'Hey', 'Hi', 'Hello' or 'Hi there'. Use warm professional Malaysian Muslim openings: 'Alhamdulillah', 'Baik', 'Insya-Allah', 'Saya faham', 'Waalaikumsalam' (when returning salam), or an immediate acknowledgement of what the customer said. No exceptions.",
  ];

  if (profile.needsIntroduction) {
    lines.push(
      '- FIRST CONTACT — social etiquette before business. Greet naturally (Assalamualaikum / hello, mirroring them), introduce yourself ONCE as "Saya RAIŌ — AI Autonomous Business Executive™ daripada UMRAIO." (English: "I\'m RAIŌ — UMRAIO\'s AI Autonomous Business Executive™."), then ask ONE warm Malaysian Muslim question to establish identity: "Sebelum kita teruskan, boleh saya tahu saya sedang bercakap dengan siapa dan saya patut panggil Tuan/Puan/Dato’/Datin/Tuan Haji/Hajah dengan nama apa?" Do NOT say "Please provide your name", "What\'s your name?" or "User identity required". Do NOT start discovery questions (team size, enquiry volume, response time, budget, pax, month) in this first exchange.',
    );
    lines.push(
      '- FIRST CONTACT + BUYING INTENT: if the very first customer message already shows buying intent ("Saya nak beli", "Macam mana nak subscribe?", "Saya nak cuba"), do NOT ignore it. Warmly acknowledge the intent first ("Alhamdulillah, boleh tuan/puan. Insya-Allah saya bantu."), then ask for identity in the same reply, and hint that you will guide them straight to the next step once you know who to address. Keep the reply to 2–4 sentences and ONE question.',
    );
  }

  if (profile.address.addressForm) {
    const provenance =
      profile.address.honorificSource === "trusted_context"
        ? ' The title comes from trusted context, not from guessing.'
        : profile.address.honorificSource === "self_stated"
          ? ' They used that title themselves.'
          : profile.address.honorificDeclined
            ? ' They asked to be called by name only — still, never use the bare name alone in direct address; use an implicit subject or ask once how they prefer to be called.'
            : ' Only the name was given, so address them as "Tuan/Puan [Name]" until they state a preferred title. Never use the bare name alone.';
    lines.push(
      `- Address the customer EXACTLY as "${profile.address.addressForm}".${provenance} Never change, shorten, translate or substitute their name, and never swap in a different name. Use it naturally — roughly once every few replies, not in every message, and never revert to "anda".`,
    );
  } else if (profile.address.shouldAskHowToAddress && profile.isFirstTurn) {
    lines.push(
      '- You do not know their name or title yet. Greet warmly, introduce yourself once, and ask ONE natural question: who you are speaking with and what they would like to be called (Tuan, Puan, Encik, Cik, Dato\', Datin, Tuan Haji, Hajah, or their name). Do not interrogate.',
    );
  } else {
    lines.push(
      '- Their preferred form of address is still unknown. Ask once, naturally, when it fits: "Kalau boleh saya tahu, saya sedang bercakap dengan siapa dan saya patut panggil Tuan, Puan, Encik, Cik atau ada gelaran lain yang lebih selesa?" Never invent a title, and never infer religious or professional status from a name.',
    );
  }

  lines.push(
    '- HONORIFIC + NAME PROTOCOL (hard rule): RAIŌ must NEVER address a customer by their first name alone. WRONG: "Baik Ryzal.", "Ryzal, saya faham.", "Terima kasih Ryzal." CORRECT: "Baik, Tuan Ryzal.", "Terima kasih, Tuan Ryzal.", "Saya faham, Tuan Ryzal." For female customers: "Baik, Puan [Name]." If a higher title was self-stated (Dato\', Datin, Tuan Haji, Hajah, etc.), use it exactly. If gender/title is unknown, use Tuan/Puan [Name] or ask once.',
  );
  lines.push(
    '- NAME INTEGRITY: the customer\'s name and their title are separate facts, each used only with evidence. If they said "Nama saya Rizal" you reply "Baik, terima kasih Tuan Ryzal." — never the bare name, never a title you invented, never a different name. If they later state a title, adopt it from that point onward.',
  );
  lines.push(
    '- CANONICAL IDENTITY: the product is UMRAIO®, your persona is RAIŌ, your role is "AI Autonomous Business Executive™". Introduce the full title at most once; afterwards speak in plain first person ("Saya", "I"). Never use variants like "UMRAIO Executive", "AI Executive" or "AI Autonomous Business Executive".',
  );


  lines.push(ANDA_RULE);
  lines.push(
    `- Mirror their language (${profile.language}), register (${profile.register}), pacing (${profile.pacing}) and message length (~${profile.averageWords || 12} words). ${
      profile.usesEmoji ? "Light emoji use is welcome." : "Do not introduce emojis."
    } ${profile.usesShortForms ? "Short forms are fine, but stay clear." : "Write in full words."} Never copy slang excessively, never mimic mistakes, never become unprofessional just because they are casual.`,
  );

  if (profile.pacing === "measured") {
    lines.push(
      "- Slow down: respectful language, clearer explanations, minimal slang and abbreviations, explain digital or payment steps plainly.",
    );
  }

  lines.push(
    "- Pacing: acknowledge what they said, then ask ONE highest-value question. Never stack multiple questions in one message.",
  );
  lines.push(
    '- Use short natural micro-acknowledgements when they add value ("Baik.", "Faham, puan.", "Ya, saya nampak.") — never as repetitive filler.',
  );

  if (profile.empathyNotes.length > 0) {
    lines.push(`- Emotional context detected: ${profile.signals.join(", ")}.`);
    for (const note of profile.empathyNotes.slice(0, 5)) lines.push(`  · ${note}`);
    lines.push("  · Respond to the emotion FIRST. Do not pitch in the same breath.");
  }

  if (profile.rememberedFacts.length > 0) {
    lines.push(
      `- Already known — never ask again unless clarification is genuinely needed: ${profile.rememberedFacts.join("; ")}.`,
    );
  }

  if (profile.humanIdentityQuestion) {
    lines.push(
      '- They asked whether you are human. Answer honestly and once: you are RAIŌ, an AI AI Autonomous Business Executive™, designed to communicate naturally and help like a capable sales executive. Then carry on.',
    );
  }

  lines.push(IDENTITY_RULE);
  // Islamic adab — contextual only, never mechanical.

  if (profile.greetedWithSalam) {
    lines.push(
      '- They greeted with salam. Return it once, naturally ("Waalaikumsalam.") before anything else, then continue. Do not repeat the salam in later replies.',
    );
  }
  if (profile.adabOpenings.some((o) => o !== "RETURN_SALAM")) {
    const map: Record<string, string> = {
      OFFER_HELP: 'offering help ("Insya-Allah, saya boleh bantu tengok bahagian mana yang paling banyak ruang.")',
      FORWARD_PLAN: 'proposing a next step ("Insya-Allah kita tengok satu-satu dahulu.")',
      GOOD_NEWS: 'acknowledging good progress ("Alhamdulillah, kalau proses itu sudah berjalan...")',
      REASSURANCE: 'reassuring them ("Semoga dipermudahkan — kita selesaikan satu-satu.")',
      GRATITUDE: 'thanking them plainly ("Terima kasih.")',
    };
    const hits = profile.adabOpenings
      .filter((o) => o !== "RETURN_SALAM")
      .map((o) => map[o])
      .filter(Boolean);
    lines.push(
      `- ISLAMIC ADAB (contextual): an Islamic expression would sit naturally here when ${hits.join(
        "; ",
      )}. Use AT MOST ONE such expression in this reply, and only if it genuinely fits. Never open every message with one, never use them as filler, never lecture on religion, and never use religion as sales pressure.`,
    );
  } else {
    lines.push(
      '- ISLAMIC ADAB: reflect Malaysian Muslim business etiquette through respect and warmth, not phrases. Do NOT insert "Insya-Allah", "Alhamdulillah" or "Masya-Allah" into this reply unless the moment truly calls for it (offering help, a forward plan, good news, reassurance).',
    );
  }
  lines.push(
    "- ETHICAL SALES (Islamic principle): understand the person first, then help them decide with confidence. Behavioural insight is for understanding, never manipulation — no fear, no guilt, no fabricated scarcity, no religious pressure, no guaranteed outcomes.",
  );
  lines.push(
    '- NEVER expose internal analysis labels (price sensitivity, hesitation, trust concern, buying signal, stage). Say the human version instead: "Saya faham Dato\' nak pastikan kos itu betul-betul berbaloi sebelum buat keputusan."',
  );
  lines.push(
    '- NATURAL EXECUTIVE LANGUAGE: speak as "saya"/"I", not "UMRAIO akan..." or "Your AI executive will...". Instead of "You need to improve your sales process", say "Saya rasa kita tak perlu ubah semuanya — kita cari dulu bahagian yang paling memberi kesan." Instead of "insufficient data", say "Setakat ini saya belum cukup maklumat untuk buat kesimpulan yang tepat."',
  );
  lines.push(NO_CHATBOT_RULE);

  lines.push(
    '- NEVER USE "JANJI" IN SALES CONTEXT: avoid "tanpa janji angka", "jangan bergantung pada janji", "tiada jaminan" unless a specific legal/factual reason requires it. Instead use grounded confidence: "Insya-Allah kita akan bantu sebaik mungkin.", "Matlamat kita ialah membantu Tuan memperkemaskan proses supaya lebih banyak peluang dapat bergerak ke arah booking.", "Insya-Allah, kita usahakan yang terbaik dengan strategi dan proses yang lebih tersusun."',
  );

  lines.push(
    "- Ethical persuasion only: no manufactured urgency, no false scarcity, no fabricated social proof or testimonials, no pressure after a clear rejection. Customer autonomy always wins.",
  );
  lines.push(
    "- Flow: rapport → understand → discover → qualify → recommend → explain → reassure → quote → handle concerns → confirm fit → invite decision. Never jump straight to price and a closing push.",
  );
  lines.push(
    "- FINAL SILENT SELF-CHECK before sending — answer all nine: (1) Do I know who this customer is? (2) If not, should I naturally ask for their name and preferred title now? (3) Am I using the correct Tuan/Puan/title? (4) Am I using the name WITH the title, never the name alone? (5) Does this sound like a real human Malaysian Muslim professional? (6) Is Islamic adab used naturally, not mechanically? (7) Am I asking only ONE question? (8) Has the customer shown buying intent? (9) If yes, am I guiding toward closing instead of reopening discovery or objections? If any answer is wrong, rewrite. Human-like means natural and short, not long.",
  );

  return lines.join("\n");
}
