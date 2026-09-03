/**
 * UMRAIO® — 24/7 AI AUTONOMOUS EXECUTIVE VOICE™ (Phase 3, pure core).
 *
 * Deterministic decisions for one live voice turn. Nothing here performs I/O,
 * nothing here fabricates content: it validates what the media gateway sent,
 * decides whether the call may still speak, classifies the caller's intent from
 * the REAL transcript, and shapes the prompt handed to RÉNAIO.CORE™.
 */

/** Ceiling for one uploaded utterance (base64 of Ogg/Opus). */
export const MAX_TURN_AUDIO_BASE64 = 3 * 1024 * 1024;
/** Ceiling for one call's stored transcript (turns), keeps the row bounded. */
export const MAX_STORED_TURNS = 60;

export type VoiceTurnKind = "greeting" | "utterance";

export type VoiceTurnRequest = {
  call_id: string;
  sequence: number;
  kind: VoiceTurnKind;
  audio_ogg_base64: string | null;
  duration_ms: number;
};

/** Strict parser — an unparsable body is rejected, never coerced. */
export function parseVoiceTurnRequest(input: unknown): VoiceTurnRequest | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const callId = typeof record["call_id"] === "string" ? record["call_id"].trim() : "";
  const kind = record["kind"];
  if (!callId || (kind !== "greeting" && kind !== "utterance")) return null;

  const audio = typeof record["audio_ogg_base64"] === "string" ? record["audio_ogg_base64"] : "";
  if (audio.length > MAX_TURN_AUDIO_BASE64) return null;
  if (kind === "utterance" && audio.length === 0) return null;

  const sequence = Number(record["sequence"]);
  const durationMs = Number(record["duration_ms"]);
  return {
    call_id: callId,
    sequence: Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 1,
    kind,
    audio_ogg_base64: audio || null,
    duration_ms: Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs) : 0,
  };
}

export type VoiceTurnSessionRow = {
  id: string;
  agency_id: string;
  call_id: string;
  caller_phone: string;
  status: string;
  meta_accepted_at: string | null;
  transcript: unknown;
  turn_count: number | null;
  detected_language: string | null;
  voice_intents: unknown;
  lead_id?: string | null;
  conversation_id?: string | null;
  closing_state?: string | null;
  disclosure_spoken?: boolean | null;
  voice_latency?: unknown;
};


export type TurnGate =
  | { allow: true }
  | { allow: false; reason: "unknown_call" | "call_terminal" | "not_accepted" | "turn_limit" };

const TERMINAL = new Set(["completed", "failed", "rejected", "missed", "terminated"]);

/**
 * A voice turn is only allowed on a call Meta has accepted and that is not
 * terminal. This never *creates* the answered state — that stays with the
 * five-condition answered proof in processGatewayCallback.
 */
export function gateVoiceTurn(session: VoiceTurnSessionRow | null): TurnGate {
  if (!session) return { allow: false, reason: "unknown_call" };
  if (TERMINAL.has(session.status)) return { allow: false, reason: "call_terminal" };
  if (!session.meta_accepted_at) return { allow: false, reason: "not_accepted" };
  if ((session.turn_count ?? 0) >= MAX_STORED_TURNS) return { allow: false, reason: "turn_limit" };
  return { allow: true };
}

export type VoiceTranscriptTurn = {
  role: "customer" | "umraio";
  text: string;
  at: string;
  duration_ms?: number;
};

export function readTranscript(raw: unknown): VoiceTranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is VoiceTranscriptTurn =>
      Boolean(t) &&
      typeof t === "object" &&
      typeof (t as VoiceTranscriptTurn).text === "string" &&
      ((t as VoiceTranscriptTurn).role === "customer" || (t as VoiceTranscriptTurn).role === "umraio"),
  );
}

export function appendTranscript(
  existing: VoiceTranscriptTurn[],
  additions: VoiceTranscriptTurn[],
): VoiceTranscriptTurn[] {
  const merged = [...existing, ...additions];
  return merged.length > MAX_STORED_TURNS ? merged.slice(merged.length - MAX_STORED_TURNS) : merged;
}

export const VOICE_INTENT_KEYS = [
  "booking",
  "quotation",
  "payment",
  "handover",
  "package_enquiry",
  "travel_dates",
  "followup",
] as const;
export type VoiceIntentKey = (typeof VOICE_INTENT_KEYS)[number];

const INTENT_PATTERNS: Record<VoiceIntentKey, RegExp> = {
  booking: /\b(book|booking|tempah|tempahan|daftar|reserve|nak pergi|confirm(?:kan)?)\b/i,
  quotation: /\b(quote|quotation|sebut ?harga|harga|price|pakej berapa|berapa)\b/i,
  payment: /\b(pay|payment|bayar|bayaran|deposit|invoice|transfer)\b/i,
  handover: /\b(human|staff|agent|operator|orang|manusia|cakap dengan|speak to someone)\b/i,
  package_enquiry: /\b(pakej|package|umrah|umroh|hotel|makkah|madinah|itinerary)\b/i,
  travel_dates: /\b(bila|tarikh|date|month|bulan|ramadan|ramadhan|syawal|cuti sekolah)\b/i,
  followup: /\b(call back|panggil semula|hubungi|nanti|later|whatsapp saya)\b/i,
};

/** Intent classification over the REAL transcript only. */
export function classifyVoiceIntents(transcript: string): VoiceIntentKey[] {
  const text = transcript.trim();
  if (!text) return [];
  return VOICE_INTENT_KEYS.filter((key) => INTENT_PATTERNS[key].test(text));
}

export function mergeIntents(existing: unknown, next: VoiceIntentKey[]): VoiceIntentKey[] {
  const previous = Array.isArray(existing)
    ? existing.filter((v): v is VoiceIntentKey => VOICE_INTENT_KEYS.includes(v as VoiceIntentKey))
    : [];
  return Array.from(new Set([...previous, ...next]));
}

/** Traveller count / budget style facts are captured verbatim, never invented. */
export function detectTravellerCount(transcript: string): number | null {
  const match = transcript.match(/\b(\d{1,2})\s*(orang|pax|people|person|travellers?|jemaah)\b/i);
  if (match?.[1]) {
    const n = Number(match[1]);
    if (n > 0 && n <= 60) return n;
  }
  const words: Record<string, number> = {
    seorang: 1,
    berdua: 2,
    bertiga: 3,
    berempat: 4,
    berlima: 5,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(transcript)) return value;
  }
  return null;
}

/**
 * The voice persona brief. Personality and greeting come from the model under
 * this brief plus the agency's own configuration — nothing is hard-coded to a
 * single language or a single sentence.
 */
export function buildVoiceSystemPrompt(args: {
  agencyName: string | null;
  preferredLanguage: string | null;
  isGreeting: boolean;
  callerPhone: string | null;
}): string {
  const brand = args.agencyName?.trim() || "UMRAIO";
  const lines = [
    `You are the 24/7 AI Autonomous Executive Voice of ${brand}, an Umrah travel agency.`,
    "You are speaking on a LIVE PHONE CALL. Every word you produce is spoken aloud.",
    "Speak like a warm, confident human executive — never an IVR, menu, robot or voicemail.",
    "Hard rules:",
    "- One or two short sentences per turn. No lists, no markdown, no emoji, no URLs.",
    "- Mirror the caller's language exactly (Bahasa Melayu, English or Arabic). Never switch unasked.",
    "- Never invent prices, availability, package details, dates or policies. If you do not know, say you will confirm.",
    "- For a quotation, payment or booking confirmation, acknowledge the request and say the details will be sent to their WhatsApp; do not attempt to transact by voice.",
    "- If the caller asks for a human, acknowledge and confirm a human will follow up.",
  ];
  if (args.preferredLanguage) {
    lines.push(`- The agency's default voice language is ${args.preferredLanguage}; use it only until the caller reveals theirs.`);
  }
  if (args.isGreeting) {
    lines.push(
      "This is the opening moment of the call. Greet the caller appropriately for an Umrah agency and ask how you can help, in one short sentence.",
    );
  }
  return lines.join("\n");
}

/** Termination is deterministic: the caller says goodbye, or limits are hit. */
export function shouldEndCall(transcript: string, turnCount: number): boolean {
  if (turnCount >= MAX_STORED_TURNS) return true;
  return /\b(bye|goodbye|terima kasih ya|selamat tinggal|assalamualaikum warahmatullah|itu saja|that's all|thank you,? bye)\b/i.test(
    transcript,
  );
}

/** Call outcome recorded at the end of the call, from observed intents only. */
export function deriveCallOutcome(intents: VoiceIntentKey[], turns: VoiceTranscriptTurn[]): string {
  if (turns.length === 0) return "no_conversation";
  if (intents.includes("handover")) return "handover_required";
  if (intents.includes("booking")) return "booking_intent";
  if (intents.includes("quotation")) return "quotation_intent";
  if (intents.includes("payment")) return "payment_intent";
  if (intents.includes("package_enquiry")) return "enquiry";
  return "conversation";
}

/**
 * Language of the spoken turn, derived from the caller's OWN words. Falls back
 * to the agency default only when the transcript carries no signal.
 */
export function detectSpokenLanguage(transcript: string, fallback: string): string {
  const text = transcript.trim();
  if (!text) return fallback;
  if (/[\u0600-\u06FF]/.test(text)) return "ar-SA";
  if (
    /\b(saya|nak|boleh|berapa|tak|awak|encik|puan|tuan|pakej|tempah|harga|bila|terima kasih|assalamualaikum)\b/i.test(
      text,
    )
  ) {
    return "ms-MY";
  }
  if (/\b(the|please|how much|i want|can you|hello|thanks|package)\b/i.test(text)) return "en-US";
  return fallback;
}
