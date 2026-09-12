/**
 * UMRAIO® — REALTIME COGNITIVE COMPLEXITY ROUTER (pure core).
 *
 * INTELLIGENCE ≠ running every cognitive stage every time.
 * INTELLIGENCE = knowing how much cognition a turn actually deserves.
 *
 * Every caller turn is classified in microseconds (regex + shape only, no I/O,
 * no model call) into one of five levels, which then decides:
 *   - whether a deterministic reflex answer is enough (LEVEL 0),
 *   - how deep RÉNAIO.CORE™ must think (LEVELS 1-4),
 *   - whether the caller must hear an acknowledgement before the thinking
 *     starts, so a live call never contains unexplained silence (LEVEL 3/4).
 *
 * Nothing here fabricates a fact: reflex replies are conversational glue only,
 * and every substantive answer still comes from RÉNAIO.CORE™.
 */

export type CognitiveLevel = 0 | 1 | 2 | 3 | 4;

export type CognitiveRoute = {
  level: CognitiveLevel;
  /** True when the turn can be answered without a model round-trip. */
  reflex: boolean;
  /** Deterministic reflex reply (LEVEL 0 only). */
  reflexText: string | null;
  /** Spoken acknowledgement to place BEFORE deep cognition (LEVEL 3/4). */
  acknowledgement: string | null;
  /** Adaptive RÉNAIO.CORE™ pipeline for this turn. */
  depth: string[];
};

export const BOOKING_STATUS_PATTERN =
  /\b(?:check|cek|tengok|periksa|status)?\s*(?:booking|tempahan)\s+saya\b|\b(?:booking|tempahan)\s+saya\s+(?:macam mana|bagaimana|status apa)\b/i;

export function isBookingStatusTurn(transcript: string): boolean {
  return BOOKING_STATUS_PATTERN.test(transcript.trim());
}

export type BookingResolutionInput = {
  knownCustomer: boolean;
  authorized: boolean;
  recordFound: boolean;
  status: string | null;
  retrievalFailed: boolean;
  verificationAlreadyAsked: boolean;
  language: string;
};

/** Governed booking-status presentation. Never emits amounts or inferred state. */
export function resolveBookingStatus(input: BookingResolutionInput): string {
  const en = english(input.language);
  if (input.retrievalFailed) {
    return en
      ? "Sorry, I couldn't retrieve your booking safely just now. Please try again shortly or WhatsApp us on this number."
      : "Maaf, saya tak dapat mendapatkan rekod tempahan dengan selamat sekarang. Cuba lagi sekejap nanti atau WhatsApp kami di nombor ini ya.";
  }
  if (!input.knownCustomer || !input.authorized) {
    if (input.verificationAlreadyAsked) {
      return en
        ? "I still can't safely verify the booking on this call. Please send the booking reference to our WhatsApp and we'll continue there."
        : "Saya masih tak dapat sahkan tempahan ini dengan selamat melalui panggilan. Hantar rujukan tempahan ke WhatsApp kami dan kita sambung di sana ya.";
    }
    return en
      ? "To verify this safely, what is the booking reference shown in your WhatsApp?"
      : "Untuk pengesahan yang selamat, apakah nombor rujukan tempahan dalam WhatsApp awak?";
  }
  if (!input.recordFound || !input.status) {
    return en
      ? "I found your WhatsApp relationship, but there isn't a verified booking record I can confirm yet. Would you like us to follow up on WhatsApp?"
      : "Saya jumpa hubungan WhatsApp awak, tapi belum ada rekod tempahan yang boleh saya sahkan. Mahu kami susulkan melalui WhatsApp?";
  }
  const labels: Record<string, { ms: string; en: string }> = {
    deposit_pending: { ms: "menunggu deposit", en: "awaiting deposit" },
    deposit_paid: { ms: "deposit sudah diterima", en: "deposit received" },
    confirmed: { ms: "disahkan", en: "confirmed" },
    cancelled: { ms: "dibatalkan", en: "cancelled" },
  };
  const label = labels[input.status]?.[en ? "en" : "ms"] ?? input.status.replace(/_/g, " ");
  return en
    ? `Your verified booking status is ${label}. I can continue with the next step on WhatsApp if you like.`
    : `Status tempahan yang disahkan ialah ${label}. Kalau awak mahu, saya boleh teruskan langkah seterusnya melalui WhatsApp.`;
}

/* ------------------------------------------------------------------ *
 * HONORIFIC INTELLIGENCE — never guessed, only read from real memory.
 * ------------------------------------------------------------------ */

const HONORIFICS = [
  "Tun", "Tan Sri", "Puan Sri", "Dato' Seri", "Datuk Seri", "Dato'", "Datuk", "Dato",
  "Datin Seri", "Datin", "Prof. Dr.", "Prof", "Dr.", "Dr", "Tuan Haji", "Tuan Hj",
  "Hajah", "Hajjah", "Haji", "Ustaz", "Ustazah", "Tuan", "Puan", "Encik", "Cik",
];

export type CallerAddress = { honorific: string | null; name: string | null; spoken: string | null };

export function resolveAddress(knownName: string | null | undefined): CallerAddress {
  const raw = (knownName ?? "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!raw) return { honorific: null, name: null, spoken: null };
  for (const title of HONORIFICS) {
    const pattern = new RegExp(`^${title.replace(/[.'()]/g, "\\$&")}(?=\\s|$)\\s*`, "i");
    if (pattern.test(raw)) {
      const rest = raw.replace(pattern, "").trim();
      const spoken = rest ? `${title} ${rest.split(" ")[0]}` : title;
      return { honorific: title, name: rest || null, spoken };
    }
  }
  return { honorific: null, name: raw, spoken: raw.split(" ")[0] ?? raw };
}

export function honorificInstruction(address: CallerAddress): string[] {
  if (!address.spoken) return ["FORM OF ADDRESS: the caller's preferred title is unknown — speak respectfully without guessing a title (never invent Dato', Tuan Haji, etc.)."];
  return [`FORM OF ADDRESS: address the caller as "${address.spoken}" when it feels natural — typically the first sentence of a turn, never in every sentence. Never upgrade or invent a different title.`];
}

/** LEVEL 0 — pure conversational reflex. */
const REFLEX_PATTERNS: Array<{ pattern: RegExp; ms: string; en: string }> = [
  { pattern: /^(awak|anda|you)\s+(sihat|okay|ok)(?:\s+tak)?\b[\s!.?]*$/i, ms: "Alhamdulillah, saya baik. Terima kasih bertanya. Awak pula?", en: "I'm well, thank you for asking. How are you?" },
  { pattern: /^(apa khabar|how are you|how're you)\b[\s!.?]*$/i, ms: "Alhamdulillah, baik. Terima kasih bertanya. Awak pula?", en: "I'm well, thank you. How are you?" },
  { pattern: /^(hello|helo|hai|hi|assalamualaikum(?: warahmatullah)?|salam)\b[\s!.?]*$/i, ms: "Waalaikumussalam, saya dengar. Apa yang boleh saya bantu?", en: "Waalaikumussalam, I can hear you. How can I help?" },
  { pattern: /^(ya|yes|ok(?:ay)?|baik|boleh|betul|setuju|uh huh|aha|hmm)\b[\s!.?]*$/i, ms: "Baik, saya faham.", en: "Understood." },
  { pattern: /^(terima kasih|thanks|thank you|tq)\b[\s!.?]*$/i, ms: "Sama-sama.", en: "You're most welcome." },
  { pattern: /^(kejap|sekejap|jap|hold on|wait|tunggu)\b[\s!.?]*$/i, ms: "Baik, saya tunggu.", en: "Of course, take your time." },
  { pattern: /\b(awak dengar tak|boleh dengar tak|can you hear me|hello\?\s*hello)\b/i, ms: "Ya, saya dengar dengan jelas.", en: "Yes, I can hear you clearly." },
];

const LEVEL4 = /\b(dokumen|document|pdf|fail|file|surat|invois|invoice|resit|receipt|kontrak|contract|polisi|policy|terma|terms|visa|pasport|passport|syarat|undang|legal|refund policy|insurans|insurance|quotation pdf|sijil|vaksin)\b/i;
const LEVEL3 = /\b(banding|compare|berbeza|beza|kenapa mahal|lebih mahal|cheaper|diskaun|discount|nego|rundingan|pilih yang mana|which one|cadangkan|recommend|itinerary|jadual penuh|multi|3 bilik|kumpulan besar|group|tak pasti nak pilih|susah nak pilih|objection|risau|ragu)\b/i;
const LEVEL2 = /\b(tadi|sebelum ni|sebelum tadi|yang kita bincang|yang saya pilih|last time|earlier|previously|macam yang|yang tu|pakej tu|quotation tu|untuk \d+ orang|untuk \d+ pax)\b/i;
const SIMPLE_FACT = /\b(berapa deposit|deposit berapa|bila|jam berapa|pukul berapa|berapa hari|berapa malam|ada tak|open tak|buka tak|nombor|alamat|lokasi|address)\b/i;

function english(language: string): boolean { return language.toLowerCase().startsWith("en"); }

const DEPTH: Record<CognitiveLevel, string[]> = {
  0: ["Understand", "Respond"], 1: ["Understand", "Classify", "Respond"],
  2: ["Understand", "Context", "Reason", "Respond"],
  3: ["Understand", "Classify", "Context", "Select Patterns", "Reason", "Critique", "Decide", "Respond"],
  4: ["Understand", "Classify", "Context", "Verify Sources", "Select Patterns", "Reason", "Critique", "Decide", "Respond", "Evaluate"],
};

const ACK_MS = ["sekejap ya, saya periksa yang itu dulu.", "beri saya sedikit masa ya, saya nak pastikan maklumat ini betul.", "saya tengok perkara itu sekejap ya."];
const ACK_EN = ["one moment please, let me check that first.", "give me a short moment, I want to get this exactly right.", "let me verify that for you now."];
function pick(list: string[], seed: number): string { return list[Math.abs(seed) % list.length] as string; }

export function buildAcknowledgement(args: { address: CallerAddress; language: string; seed: number }): string {
  const title = args.address.honorific;
  if (english(args.language)) return (title ? `Okay ${title}, ` : "Okay, ") + pick(ACK_EN, args.seed);
  const text = pick(ACK_MS, args.seed);
  return title ? text.replace(/\bya\b/, `ya ${title}`) : text;
}

export function routeTurn(args: { transcript: string; language: string; address: CallerAddress; seed?: number }): CognitiveRoute {
  const text = (args.transcript ?? "").trim();
  const seed = args.seed ?? text.length;
  const en = english(args.language);
  if (!text) return { level: 1, reflex: false, reflexText: null, acknowledgement: null, depth: DEPTH[1] };
  for (const reflex of REFLEX_PATTERNS) {
    if (reflex.pattern.test(text)) return { level: 0, reflex: true, reflexText: en ? reflex.en : reflex.ms, acknowledgement: null, depth: DEPTH[0] };
  }
  let level: CognitiveLevel;
  if (LEVEL4.test(text)) level = 4; else if (LEVEL3.test(text)) level = 3; else if (LEVEL2.test(text)) level = 2; else if (SIMPLE_FACT.test(text) || text.split(/\s+/).length <= 6) level = 1; else level = 2;
  const acknowledgement = level >= 3 ? buildAcknowledgement({ address: args.address, language: args.language, seed }) : null;
  return { level, reflex: false, reflexText: null, acknowledgement, depth: DEPTH[level] };
}

export function depthInstruction(route: CognitiveRoute): string[] {
  const lines = [`ADAPTIVE COGNITION: this turn is complexity LEVEL ${route.level}. Run only these stages: ${route.depth.join(" → ")}.`];
  if (route.level <= 1) lines.push("Answer immediately in ONE short spoken sentence. No analysis, no options list, no closing pitch.");
  else if (route.level === 2) lines.push("Use what you already know about this customer and answer in one or two short sentences. Do not re-qualify facts you already have.");
  else if (route.level === 3) lines.push("Give the answer in one or two short spoken sentences. Any processing acknowledgement is handled separately; never repeat it.");
  else lines.push("Answer briefly from verified context only. Any processing acknowledgement is handled separately. Say what you can confirm on WhatsApp instead of guessing.");
  return lines;
}
