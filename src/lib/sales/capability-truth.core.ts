/**
 * UMRAIO® — CAPABILITY TRUTH LAYER (pure).
 *
 * The model must never contradict what the system just did. UMRAIO can send
 * WhatsApp text replies and (when speech synthesis succeeds) WhatsApp voice
 * notes. It cannot place a live phone call. Those three facts are stated in the
 * prompt AND enforced deterministically on the generated text, because a prompt
 * alone has proven insufficient.
 */

export type CapabilityState = {
  /** Voice-note replies are enabled / were just delivered for this turn. */
  voiceAvailable: boolean;
  /**
   * Live inbound WhatsApp Calling is deployed and answering. Resolved from the
   * canonical capability registry, never assumed per channel.
   */
  callingAvailable?: boolean;
};

export const LIVE_CALL_UNAVAILABLE_MS =
  "Buat masa ini panggilan telefon secara langsung belum tersedia, tetapi saya boleh terus berbual di WhatsApp sini.";

/** Truthful answer when WhatsApp Calling IS live. */
export const LIVE_CALL_AVAILABLE_MS =
  "Boleh, panggilan WhatsApp memang tersedia — Datuk boleh terus call nombor WhatsApp ini dan saya akan jawab.";

/** Sentences that falsely deny live calling while Calling is enabled. */
const FALSE_CALL_DENIAL_PATTERNS: RegExp[] = [
  /\b(?:panggilan\s+(?:telefon|whatsapp|suara)|call|telefon|phone\s+call)\b[^.!?]{0,60}\b(?:belum|tidak|tak)\s+(?:tersedia|boleh|dapat|ada)\b/i,
  /\b(?:saya|kami)\s+(?:tidak|tak)\s+(?:boleh|dapat)\s+(?:terima|jawab|buat)\s+(?:panggilan|call)\b/i,
  /\b(?:i|we)\s+(?:can(?:'|’)?t|cannot|am\s+not\s+able\s+to)\s+(?:take|make|answer)\s+(?:a\s+)?(?:phone\s+)?calls?\b/i,
  /\b(?:phone|voice)\s+calls?\b[^.!?]{0,40}\b(?:not\s+available|unavailable|not\s+supported)\b/i,
];

/**
 * Used when a reply consisted ONLY of forbidden capability-denial text. Never
 * return the original in that case — it would ship the exact contradiction.
 */
export const VOICE_CAPABILITY_FALLBACK_MS =
  "Baik, saya boleh terus bantu di sini — melalui mesej atau nota suara. Boleh saya tahu bulan berapa Datuk bercadang nak berangkat?";

/** True when the text already tells the customer phone calls are unavailable. */
function mentionsLiveCallUnavailable(text: string): boolean {
  return /\b(?:panggilan\s+telefon|call|telefon|phone\s+call)\b[^.!?]{0,60}\b(?:belum|tidak|tak|not)\b/i.test(
    text,
  );
}

/**
 * Sentences that deny a capability UMRAIO actually has. Matched per sentence so
 * only the false sentence is removed, never the whole reply.
 */
const FALSE_VOICE_DENIAL_PATTERNS: RegExp[] = [
  /\btidak\s+(?:boleh|dapat)\b[^.!?]{0,60}\b(?:bercakap|bersuara|hantar\s+(?:nota\s+)?suara|voice\s*note|voice\s*message|audio)\b/i,
  /\btak\s+(?:boleh|dapat)\b[^.!?]{0,60}\b(?:bercakap|bersuara|hantar\s+(?:nota\s+)?suara|voice\s*note|voice\s*message|audio)\b/i,
  /\b(?:tiada|tak\s+ada|tidak\s+ada|belum\s+ada|tak\s+wujud)\b[^.!?]{0,60}\b(?:voice\s*note|nota\s+suara|fungsi\s+suara|suara)\b/i,
  /\b(?:voice\s*note|nota\s+suara)\b[^.!?]{0,40}\b(?:tiada|tak\s+ada|tidak\s+ada|tidak\s+tersedia|belum\s+tersedia|tak\s+tersedia)\b/i,
  /\bhanya\s+boleh\s+(?:balas|hantar|beri|bantu|berkomunikasi|berhubung)\b[^.!?]{0,60}\b(?:teks|tulisan|bertulis|mesej\s+tulisan|mesej\s+bertulis|text)\b/i,
  /\b(?:melalui|dengan|guna(?:kan)?)\s+mesej\s+(?:bertulis|tulisan|teks)\s+sahaja\b/i,
  /\bmesej\s+(?:bertulis|tulisan|teks)\s+sahaja\b/i,
  /\bsaya\s+hanya\s+(?:sebuah\s+)?(?:sistem\s+)?ai\s+teks\b/i,
  /\b(?:i\s+)?(?:can(?:'|’)?t|cannot|am\s+not\s+able\s+to)\b[^.!?]{0,60}\b(?:speak|talk|send\s+(?:a\s+)?voice\s*(?:note|message)|send\s+audio)\b/i,
  /\bi\s+can\s+only\s+(?:reply|respond|send|help)\b[^.!?]{0,40}\b(?:text|written)\b/i,
  /\bi\s*(?:'|’)?m\s+(?:only|just)\s+a\s+text[-\s]?(?:based\s+)?(?:ai|bot|assistant)\b/i,
];

/** Unnecessary self-referential machine talk during normal sales conversation. */
const SELF_REFERENTIAL_PATTERNS: RegExp[] = [
  /\bsaya\s+(?:ialah|adalah|merupakan)\s+(?:sebuah\s+)?(?:sistem\s+)?ai\b[^.!?]*/i,
  /\bsaya\s+(?:ialah|adalah|merupakan)\s+(?:sebuah\s+)?(?:bot|robot|program|mesin|chatbot)\b[^.!?]*/i,
  /\bas\s+an\s+ai\s+(?:language\s+)?(?:model|system|assistant)\b[^.!?]*/i,
];

const AI_IDENTITY_QUESTION =
  /\b(?:awak|kamu|anda|you)\b[^.?!]{0,20}\b(?:ai|bot|robot|manusia|human|real\s+person|mesin|machine)\b|\badakah\s+(?:awak|kamu|anda)\b|\bare\s+you\s+(?:an?\s+)?(?:ai|bot|robot|human|real)\b|\bsiapa\s+(?:awak|kamu|anda)\b/i;

const LIVE_CALL_REQUEST =
  /\b(?:call|telefon|telefonkan|panggil(?:an)?|hubungi)\b[^.?!]{0,30}\b(?:saya|aku|i|me|terus|sekarang)\b|\bboleh\s+(?:call|telefon)\b|\blive\s+call\b|\bphone\s+call\b/i;

export function customerAskedAboutAiIdentity(text: string | null | undefined): boolean {
  return AI_IDENTITY_QUESTION.test(text ?? "");
}

export function customerAskedForLiveCall(text: string | null | undefined): boolean {
  return LIVE_CALL_REQUEST.test(text ?? "");
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

/**
 * Removes forbidden sentences while PRESERVING the model's original line and
 * paragraph structure. The previous implementation joined every surviving
 * sentence with a space, which accidentally destroyed WhatsApp blank lines,
 * bullets and scannable formatting even when the model produced them correctly.
 */
function filterForbiddenPreservingLayout(text: string, drop: RegExp[]): string {
  if (!drop.length || !text) return text;

  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "";
      const kept = splitSentences(line).filter(
        (sentence) => !drop.some((pattern) => pattern.test(sentence)),
      );
      return kept.join(" ").trim();
    })
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bold compact WhatsApp labels without changing any underlying fact/value. */
function boldWhatsAppLabels(line: string): string {
  if (!line || /^\s*\*/.test(line)) return line;
  const label = /(Hari\s+\d+(?:\s*[–-]\s*\d+)?|Pakej|Harga(?:\s+seorang)?|Jumlah|Deposit|Rujukan|Tempoh|Hotel|Tarikh|Bulan|Jemaah|Status|Quotation|Payment\s+link|Link\s+payment)/i;
  return line.replace(
    new RegExp(`^(\\s*[•-]?\\s*)(${label.source})(\\s*:)`, "i"),
    (_m, prefix: string, name: string) => `${prefix}*${name}:*`,
  );
}

/**
 * Final deterministic readability guard for customer-facing WhatsApp text.
 * It does not invent facts or truncate content; it only restores whitespace,
 * separates dense prose, preserves bullets/URLs and highlights useful labels.
 */
function enforceWhatsAppReadability(text: string): string {
  let value = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!value) return value;

  // Recover bullet boundaries when an upstream stage/model emitted them inline.
  value = value.replace(/\s+(?=•\s+)/g, "\n");

  let lines = value.split("\n").map((line) => boldWhatsAppLabels(line.trimEnd()));

  const firstBullet = lines.findIndex((line) => /^\s*•\s+/.test(line));
  if (firstBullet > 0 && lines[firstBullet - 1]?.trim()) {
    lines.splice(firstBullet, 0, "");
  }

  // Add a visual break after a contiguous bullet block when prose continues.
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^\s*•\s+/.test(lines[i] ?? "") && !/^\s*•\s+/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").trim()) {
      lines.splice(i + 1, 0, "");
      break;
    }
  }

  value = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // If a long reply still contains no paragraph break or bullet structure,
  // group sentences into short mobile-friendly paragraphs. No content is lost.
  if (value.length > 320 && !value.includes("\n\n") && !/^\s*•\s+/m.test(value)) {
    const sentences = splitSentences(value).map((s) => s.trim()).filter(Boolean);
    if (sentences.length >= 3) {
      const paragraphs: string[] = [];
      for (let i = 0; i < sentences.length; i += 2) {
        paragraphs.push(sentences.slice(i, i + 2).join(" "));
      }
      value = paragraphs.join("\n\n");
    }
  }

  // Structural title for itinerary-style answers; no business fact is invented.
  if (/\bHari\s+1\s*:/i.test(value) && !/^\*[^\n]+\*\s*$/m.test(value.split("\n")[0] ?? "")) {
    value = `*ITINERARI UMRAH*\n\n${value}`;
  }

  return value.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Deterministically removes sentences that deny a capability the system has,
 * and (unless the customer asked) unnecessary "I am an AI system" statements.
 */
export function sanitizeCapabilityClaims(
  text: string,
  options: CapabilityState & { customerAskedIdentity?: boolean; liveCallRequested?: boolean },
): string {
  const original = (text ?? "").trim();
  const drop: RegExp[] = [];
  if (options.voiceAvailable) drop.push(...FALSE_VOICE_DENIAL_PATTERNS);
  if (options.callingAvailable) drop.push(...FALSE_CALL_DENIAL_PATTERNS);
  if (!options.customerAskedIdentity) drop.push(...SELF_REFERENTIAL_PATTERNS);

  let cleaned = filterForbiddenPreservingLayout(original, drop);

  // A reply made up ONLY of forbidden denial text must never be shipped as-is.
  if (!cleaned) {
    if (options.callingAvailable && original && FALSE_CALL_DENIAL_PATTERNS.some((p) => p.test(original))) {
      cleaned = LIVE_CALL_AVAILABLE_MS;
    } else {
      cleaned = options.voiceAvailable && original ? VOICE_CAPABILITY_FALLBACK_MS : original;
    }
  }

  // Runtime enforcement (not prompt-only): the customer asked for a phone call.
  if (options.liveCallRequested) {
    if (options.callingAvailable) {
      if (!/\b(?:boleh|tersedia|available|call\s+saya|jawab)\b/i.test(cleaned)) {
        cleaned = cleaned ? `${LIVE_CALL_AVAILABLE_MS}\n\n${cleaned}` : LIVE_CALL_AVAILABLE_MS;
      }
    } else if (!mentionsLiveCallUnavailable(cleaned)) {
      cleaned = cleaned ? `${LIVE_CALL_UNAVAILABLE_MS}\n\n${cleaned}` : LIVE_CALL_UNAVAILABLE_MS;
    }
  }

  return enforceWhatsAppReadability(cleaned);
}

/** Prompt lines injected into the sales system prompt. */
export function capabilityTruthInstructions(state: CapabilityState): string[] {
  return [
    `CAPABILITY TRUTH (absolute): WhatsApp text reply = available. WhatsApp voice-note reply = ${
      state.voiceAvailable ? "AVAILABLE and already in use in this conversation" : "available when voice generation succeeds"
    }. Live WhatsApp call = ${
      state.callingAvailable
        ? "AVAILABLE — RAIŌ answers inbound WhatsApp calls on this same number. Never say phone calls are unavailable."
        : "NOT available yet. If the customer asks for a phone call, say only that live phone calling is not available at the moment and continue on WhatsApp."
    } Never claim you cannot speak, cannot send a voice note, or that you can "only reply in text" — that is false.`,

    "SELF-REFERENCE: do not announce that you are an AI, a system, a bot or a program during a normal sales conversation. Disclose it plainly and briefly only when the customer directly asks. Otherwise behave as a professional Malaysian Umrah sales consultant — truthful about what the service can do, never pretending to be something it is not.",
    "VOICE-NOTE STYLE: keep spoken replies short and natural in Malaysian Malay, warm and professional, one useful follow-up question at a time. No long robotic explanations, no IVR or call-centre phrasing, no repeated disclaimers, no repeating the customer's title in every sentence. Keep Islamic courtesy (salam) natural and unforced.",
  ];
}
