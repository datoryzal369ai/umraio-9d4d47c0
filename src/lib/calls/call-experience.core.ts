/**
 * UMRAIO® — REALTIME CALLING EXPERIENCE (pure core).
 *
 * Deterministic conversational behaviour for a live WhatsApp call:
 *   - RAIŌ speaks FIRST (greeting + one-time recording/AI disclosure)
 *   - a natural CALL CLOSING state machine instead of a crude silence timeout
 *   - sanitized per-turn latency accounting
 *
 * Everything here is pure: no I/O, no model calls, no fabricated facts. The
 * fast conversational path uses these helpers so an acknowledgement, a
 * completion check or a farewell never pays an LLM round-trip.
 */

/* ------------------------------------------------------------------ *
 * 1. OPENING — greeting first, disclosure exactly once per call.
 * ------------------------------------------------------------------ */

export type CallOpening = { text: string; disclosureSpoken: boolean };

/**
 * The opening line. Deterministic on purpose: it is the lowest-latency
 * possible first audio, and the recording/AI disclosure must be stable,
 * reviewable wording rather than model output.
 */
export function buildCallOpening(args: {
  agencyName: string | null;
  language: string;
  disclosureAlreadySpoken?: boolean;
  knownName?: string | null;
  variant?: number;
}): CallOpening {
  const brand = args.agencyName?.trim() || "UMRAIO";
  const english = args.language.toLowerCase().startsWith("en");
  const needDisclosure = !args.disclosureAlreadySpoken;
  const name = args.knownName?.trim() ? ` ${args.knownName.trim()}` : "";

  if (english) {
    const parts = [`Assalamualaikum${name}. I'm RAIŌ from ${brand}.`];
    if (needDisclosure) {
      parts.push(
        "This AI call may be recorded for quality and training.",
      );
    }
    parts.push(pick(["How can I help?", "How are you? What can I help with?", "Yes, what would you like to ask?"], args.variant ?? 0));
    return { text: parts.join(" "), disclosureSpoken: true };
  }

  const parts = [`Assalamualaikum${name}. Saya RAIŌ, AI dari ${brand}.`];
  if (needDisclosure) {
    parts.push(
      "Panggilan ini mungkin dirakam untuk kualiti dan latihan.",
    );
  }
  parts.push(pick(["Ya, macam mana saya boleh bantu?", "Apa khabar? Nak tanya apa hari ini?", "Ya, apa yang boleh saya bantu?"], args.variant ?? 0));
  return { text: parts.join(" "), disclosureSpoken: true };
}

/* ------------------------------------------------------------------ *
 * 2. CALL CLOSING STATE MACHINE
 * ------------------------------------------------------------------ */

export const CLOSING_STATES = [
  "active",
  "possible_completion",
  "completion_check",
  "confirmed_complete",
  "farewell",
] as const;
export type ClosingState = (typeof CLOSING_STATES)[number];

export type ClosingAction =
  | { action: "continue"; state: ClosingState }
  | { action: "await_termination"; state: "farewell" }
  | { action: "completion_check"; state: "completion_check"; text: string }
  | { action: "farewell"; state: "farewell"; text: string };

export function readClosingState(raw: unknown): ClosingState {
  return CLOSING_STATES.includes(raw as ClosingState) ? (raw as ClosingState) : "active";
}

/** Soft "we may be done" signals — a thank-you, a wrap-up phrase. */
const SOFT_COMPLETION =
  /\b(terima kasih|thanks|thank you|ok(?:ay)?(?: dah)?|baik(?:lah)?|itu (?:je|sahaja|saja)|that'?s all|dah cukup|sudah cukup)\b/i;

/** Explicit "nothing else" confirmation, or an outright goodbye. */
const EXPLICIT_DONE =
  /\b(tak ada|takde|tiada|no more|nothing else|that'?s it|cukup(?: lah)?|selesai|bye|goodbye|selamat tinggal|assalamualaikum warahmatullah)\b/i;

/** The caller clearly still needs something. */
const CONTINUES =
  /\b(ada|nak tanya|satu lagi|lagi satu|soalan|question|boleh tak|macam mana|berapa|how much|can you|actually|sebenarnya|tunggu|wait)\b/i;

const COMPLETION_CHECKS_MS = [
  "Baik, sebelum kita tamatkan panggilan ni, ada apa-apa lagi yang saya boleh bantu?",
  "Yang lain semua okay? Ada apa-apa lagi yang perlu saya periksa?",
  "Selain daripada tu, ada apa-apa lagi yang boleh saya tolong?",
];
const COMPLETION_CHECKS_EN = [
  "Before we end the call, is there anything else I can help you with?",
  "Is everything else clear, or anything else you'd like me to check?",
  "Anything else I can assist you with today?",
];
const FAREWELLS_MS = [
  "Baik, terima kasih ya. Assalamualaikum.",
  "Terima kasih. Jaga diri ya, assalamualaikum.",
];
const FAREWELLS_EN = [
  "Thank you. Take care, assalamualaikum.",
  "Thanks for calling. Assalamualaikum.",
];

/**
 * EXPLICIT HANGUP COMMAND (Calling only).
 *
 * A direct instruction to end THIS call ("awak putuskanlah", "tamatkan
 * panggilan", "hang up", "end the call"). It outranks every other closing
 * branch: asking one more completion check after the caller has told RAIŌ to
 * hang up is the defect this guard removes.
 */
const HANGUP_COMMAND =
  /\b(?:putuskan(?:lah)?\s+(?:talian|panggilan)\b|putuskanlah\b(?=\s*(?:[,.!?]|$))|tamatkan(?:lah)?\s+(?:talian|panggilan|call)\b|hang\s?up\b|hangup\b|end\s+(?:the\s+|this\s+)?call\b|letak(?:kan)?\s+(?:telefon|phone)\b)/i;

/** Never treat a refusal to hang up as a command. */
const HANGUP_NEGATED =
  /\b(?:jangan|janganlah|tak\s+payah|tak\s+usah|usah|belum|don'?t|do\s+not|no\s+need\s+to|please\s+don'?t)\b[^.?!]{0,24}?(?:putus|tamatkan|hang\s?up|hangup|end\s+(?:the\s+|this\s+)?call|letak)/i;

/** A question or report ABOUT a dropped line is not an instruction. */
const HANGUP_REPORT = /\?\s*$|\b(tadi|tadian|sebentar tadi|just now|earlier)\b/i;

/** A direct polite request may end in "?" without being a dropped-line report. */
const HANGUP_POLITE_REQUEST =
  /^\s*(?:boleh(?:kan)?(?:\s+awak|\s+anda)?|can\s+you|could\s+you|would\s+you)\s+(?:please\s+)?(?:putuskan(?:lah)?\s+(?:talian|panggilan)|tamatkan(?:lah)?\s+(?:talian|panggilan|call)|hang\s?up|end\s+(?:the\s+|this\s+)?call)(?:\s+please)?\s*\?\s*$/i;

export function isExplicitHangupCommand(transcript: string): boolean {
  const text = transcript.trim();
  if (!text) return false;
  if (HANGUP_NEGATED.test(text)) return false;
  // A business object ("putuskan tempahan") is never a hangup. HANGUP_COMMAND
  // already requires an explicit talian/panggilan/call object, so only the
  // dropped-line report needs its own veto (handled by HANGUP_REPORT below).
  if (/\b(?:putuskan|tamatkan)(?:lah)?\s+(?:tempahan|booking|jumlah|bayaran|payment)\b/i.test(text)) return false;
  if (/^(?:awak\s+tak\s+putuskan\s+ke|awak\s+boleh\s+putuskan|(?:boleh\s+)?(?:awak\s+)?putuskan)(?:\s+(?:sekarang|ya|lah))?[\s.!?]*$/i.test(text)) return true;
  if (HANGUP_REPORT.test(text) && !HANGUP_POLITE_REQUEST.test(text)) return false;
  return HANGUP_COMMAND.test(text);
}

/**
 * The spoken farewell RAIŌ uses when the caller has explicitly asked to end
 * the call. Shared by the legacy closing machine and the cognitive bridge so
 * both planes say goodbye in the same voice before termination.
 */
export function callingFarewellText(language: string, seed: number): string {
  const english = language.toLowerCase().startsWith("en");
  return pick(english ? FAREWELLS_EN : FAREWELLS_MS, seed);
}

// Whole-turn completion only. A thank-you followed by business is not a goodbye.
const NATURAL_FAREWELL = /^(?:(?:ok(?:ay|ey)?|baik(?:lah)?)[,\s]+)?(?:terima kasih(?:\s+ya)?|itu (?:sahaja|saja|je)|(?:dah|sudah) cukup|(?:dah\s+)?(?:tak ada|takde|tiada)(?:\s+apa(?:-apa)? lagi|\s+lagi|\s+dah)?|bye|goodbye|that'?s all)[\s.!]*$/i;

function semanticFarewell(text: string): boolean {
  // Thanks may be embedded in a goodbye, but not in a new question/request.
  if (/\?|\b(?:jangan|belum|tak selesai|belum selesai|nak tanya|satu lagi|soalan|berapa|hantar|quotation|tempahan|bayaran|harga|booking|payment|question|don't|do not|not done)\b/i.test(text)) return false;
  return /\b(?:selamat tinggal|(?:okay|ok|okey) bye|dah selesai|sudah selesai|itu (?:je|sahaja|saja)|nanti saya (?:call|telefon|hubungi)(?: awak)? balik|(?:dah )?tak ada apa(?:-apa)? lagi)\b/i.test(text);
}

function pick(list: string[], seed: number): string {
  return list[Math.abs(seed) % list.length] as string;
}


/**
 * One deterministic step of the closing machine.
 *
 * Silence alone never initiates closing. An unambiguous whole-turn farewell
 * can end naturally; thanks followed by new business must stay open.
 * Pending work blocks inferred completion.
 */
export function advanceClosing(args: {
  state: ClosingState;
  transcript: string;
  language: string;
  turnCount: number;
  maxTurns: number;
  /** Block termination while governed work is still outstanding. */
  pendingWork?: boolean;
}): ClosingAction {
  const text = args.transcript.trim();
  const english = args.language.toLowerCase().startsWith("en");
  const seed = args.turnCount;

  // Persisted farewell is a commitment, not an invitation to ask again.
  // Only a fresh, nonempty caller utterance can reopen conversation.
  if (args.state === "farewell" && !text) {
    return { action: "await_termination", state: "farewell" };
  }

  // Hard ceiling — still spoken, never a silent hang-up.
  if (args.turnCount >= args.maxTurns) {
    return {
      action: "farewell",
      state: "farewell",
      text: pick(english ? FAREWELLS_EN : FAREWELLS_MS, seed),
    };
  }

  // Explicit instruction to hang up wins over pending work and over any
  // further completion check: speak the farewell, then end the call.
  if (isExplicitHangupCommand(text)) {
    return {
      action: "farewell",
      state: "farewell",
      text: pick(english ? FAREWELLS_EN : FAREWELLS_MS, seed),
    };
  }

  if (args.pendingWork) return { action: "continue", state: "active" };

  if (NATURAL_FAREWELL.test(text) || semanticFarewell(text)) {
    return { action: "farewell", state: "farewell", text: pick(english ? FAREWELLS_EN : FAREWELLS_MS, seed) };
  }

  if (HANGUP_NEGATED.test(text) || /\b(?:tak selesai|belum selesai|kenapa tadi terputus|putuskan (?:tempahan|jumlah bayaran))\b/i.test(text)) {
    return { action: "continue", state: "active" };
  }
  if (/\?|\b(?:nak tanya|satu lagi|soalan|harga|bayaran|tempahan|booking|payment|question)\b/i.test(text)) {
    return { action: "continue", state: "active" };
  }


  if (args.state === "completion_check") {
    if (text && CONTINUES.test(text) && !EXPLICIT_DONE.test(text)) {
      return { action: "continue", state: "active" };
    }
    if (!text || EXPLICIT_DONE.test(text) || SOFT_COMPLETION.test(text)) {
      return {
        action: "farewell",
        state: "farewell",
        text: pick(english ? FAREWELLS_EN : FAREWELLS_MS, seed),
      };
    }
    return { action: "continue", state: "active" };
  }

  if (!text) return { action: "continue", state: args.state };

  if (EXPLICIT_DONE.test(text) || (SOFT_COMPLETION.test(text) && !CONTINUES.test(text))) {
    return {
      action: "completion_check",
      state: "completion_check",
      text: pick(english ? COMPLETION_CHECKS_EN : COMPLETION_CHECKS_MS, seed),
    };
  }

  return { action: "continue", state: "active" };
}

/* ------------------------------------------------------------------ *
 * 3. LATENCY ACCOUNTING
 * ------------------------------------------------------------------ */

export type TurnLatency = {
  seq: number;
  kind: string;
  asr_ms: number;
  context_ms: number;
  reasoning_ms: number;
  tts_ms: number;
  total_ms: number;
  fast_path: boolean;
  /** Routed cognitive complexity level (0-4) for this turn. */
  level?: number;
  /** True when the caller heard an acknowledgement before the reasoned answer. */
  acknowledged?: boolean;
  /**
   * Media-plane timings reported by the gateway (additive instrumentation).
   * `vad_finalize_ms` is for this turn; the playback fields describe the turn
   * named by `prev_sequence`, since they only exist once audio has been sent.
   */
  media?: {
    vad_finalize_ms?: number;
    prev_sequence?: number;
    tts_ms?: number;
    tts_encode_ms?: number;
    playback_start_ms?: number;
    speech_end_to_first_audio_ms?: number;
    acknowledgement_first_audio_ms?: number;
    playback_complete_ms?: number;
    accepted_to_greeting_ms?: number;
    ready_to_greeting_ms?: number;
  };
};

export function appendLatency(existing: unknown, entry: TurnLatency, max = 60): TurnLatency[] {
  const prior = Array.isArray(existing)
    ? (existing.filter((e) => e && typeof e === "object") as TurnLatency[])
    : [];
  const merged = [...prior, entry];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

export function summarizeLatency(entries: TurnLatency[]): Record<string, number> {
  const totals = entries.map((e) => e.total_ms).filter((n) => Number.isFinite(n));
  return {
    turns: entries.length,
    p50_total_ms: percentile(totals, 50),
    p95_total_ms: percentile(totals, 95),
    worst_total_ms: totals.length ? Math.max(...totals) : 0,
    p50_asr_ms: percentile(entries.map((e) => e.asr_ms ?? 0), 50),
    p50_context_ms: percentile(entries.map((e) => e.context_ms ?? 0), 50),
    p50_reasoning_ms: percentile(entries.map((e) => e.reasoning_ms ?? 0), 50),
    p50_tts_ms: percentile(entries.map((e) => e.tts_ms ?? 0), 50),
    ...summarizeMediaLatency(entries),
  };
}

/** Percentiles for the media plane, reported only when actually measured. */
function summarizeMediaLatency(entries: TurnLatency[]): Record<string, number> {
  const pick = (key: keyof NonNullable<TurnLatency["media"]>): number[] =>
    entries
      .map((e) => e.media?.[key])
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const out: Record<string, number> = {};
  const add = (name: string, values: number[]) => {
    if (values.length === 0) return;
    out[`p50_${name}`] = percentile(values, 50);
    out[`p95_${name}`] = percentile(values, 95);
  };
  add("vad_finalize_ms", pick("vad_finalize_ms"));
  add("media_tts_ms", pick("tts_ms"));
  add("media_tts_encode_ms", pick("tts_encode_ms"));
  add("playback_start_ms", pick("playback_start_ms"));
  add("speech_end_to_first_audio_ms", pick("speech_end_to_first_audio_ms"));
  add("acknowledgement_first_audio_ms", pick("acknowledgement_first_audio_ms"));
  add("playback_complete_ms", pick("playback_complete_ms"));
  add("accepted_to_greeting_ms", pick("accepted_to_greeting_ms"));
  add("ready_to_greeting_ms", pick("ready_to_greeting_ms"));
  return out;
}
