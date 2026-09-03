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
}): CallOpening {
  const brand = args.agencyName?.trim() || "UMRAIO";
  const english = args.language.toLowerCase().startsWith("en");
  const needDisclosure = !args.disclosureAlreadySpoken;
  const name = args.knownName?.trim() ? ` ${args.knownName.trim()}` : "";

  if (english) {
    const parts = [`Assalamualaikum${name}, thank you for calling ${brand}.`];
    if (needDisclosure) {
      parts.push(
        "Just to let you know, this call may be recorded for quality, training and AI improvement.",
      );
    }
    parts.push("I'm RAIŌ. How may I help you?");
    return { text: parts.join(" "), disclosureSpoken: true };
  }

  const parts = [`Assalamualaikum${name}, terima kasih kerana menghubungi ${brand}.`];
  if (needDisclosure) {
    parts.push(
      "Untuk makluman, perbualan ini mungkin dirakam bagi tujuan kualiti, latihan dan penambahbaikan sistem AI kami.",
    );
  }
  parts.push("Saya RAIŌ. Apa yang boleh saya bantu?");
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
  "Yang lain semua okay? Ada apa-apa lagi yang encik nak saya semak?",
  "Selain daripada tu, ada apa-apa lagi yang boleh saya tolong?",
];
const COMPLETION_CHECKS_EN = [
  "Before we end the call, is there anything else I can help you with?",
  "Is everything else clear, or anything else you'd like me to check?",
  "Anything else I can assist you with today?",
];
const FAREWELLS_MS = [
  "Baik, terima kasih. Kalau ada apa-apa nanti terus WhatsApp atau hubungi kami ya. Assalamualaikum.",
  "Terima kasih banyak. Saya akan susulkan melalui WhatsApp. Jaga diri, assalamualaikum.",
];
const FAREWELLS_EN = [
  "Thank you. If anything comes up, just WhatsApp or call us anytime. Assalamualaikum.",
  "Thanks so much. I'll follow up on WhatsApp. Take care, assalamualaikum.",
];

function pick(list: string[], seed: number): string {
  return list[Math.abs(seed) % list.length] as string;
}

/**
 * One deterministic step of the closing machine.
 *
 * A call is NEVER ended just because the caller went quiet or said "thanks":
 * RAIŌ asks a completion check first, and only an explicit confirmation (or a
 * hard turn limit) reaches the farewell.
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

  // Hard ceiling — still spoken, never a silent hang-up.
  if (args.turnCount >= args.maxTurns) {
    return {
      action: "farewell",
      state: "farewell",
      text: pick(english ? FAREWELLS_EN : FAREWELLS_MS, seed),
    };
  }

  if (args.pendingWork) return { action: "continue", state: "active" };

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
  };
}
