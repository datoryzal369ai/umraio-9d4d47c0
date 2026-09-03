/**
 * UMRAIO® — CONFIDENTIAL INTERNAL INTELLIGENCE BOOSTER (pure core).
 *
 * This layer does NOT decide anything. RÉNAIO.CORE™ remains the single
 * cognitive authority; this module only maintains lightweight ROLLING
 * perception signals for a live call and turns them into behaviour guidance
 * lines for the prompt (HOW RAIŌ talks, never WHAT it decides).
 *
 * Properties that matter for a realtime call:
 *  - incremental: every turn nudges the previous state, nothing is recomputed
 *    from the full history, so cost stays flat as the call grows;
 *  - pure + deterministic: no I/O, no model call, no added latency;
 *  - never fabricates facts — it describes conversational behaviour only.
 *
 * The internal codename is never emitted into any customer-facing text.
 */

export type ConversationSignals = {
  interest: number;
  hesitation: number;
  confusion: number;
  frustration: number;
  urgency: number;
  trust: number;
  price_sensitivity: number;
  comparison: number;
  decision_readiness: number;
  reassurance_need: number;
  information_overload: number;
  buying_intent: number;
};

const KEYS: (keyof ConversationSignals)[] = [
  "interest",
  "hesitation",
  "confusion",
  "frustration",
  "urgency",
  "trust",
  "price_sensitivity",
  "comparison",
  "decision_readiness",
  "reassurance_need",
  "information_overload",
  "buying_intent",
];

export const NEUTRAL_SIGNALS: ConversationSignals = {
  interest: 0.35,
  hesitation: 0.2,
  confusion: 0.1,
  frustration: 0.05,
  urgency: 0.15,
  trust: 0.4,
  price_sensitivity: 0.25,
  comparison: 0.1,
  decision_readiness: 0.15,
  reassurance_need: 0.2,
  information_overload: 0.1,
  buying_intent: 0.2,
};

const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));

/** Reads a persisted signal blob, tolerating nulls and partial/legacy shapes. */
export function readSignals(raw: unknown): ConversationSignals {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...NEUTRAL_SIGNALS };
  for (const key of KEYS) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) out[key] = clamp(value);
  }
  return out;
}

type Cue = { key: keyof ConversationSignals; delta: number; pattern: RegExp };

/** Malay / English / Manglish conversational cues observed on real calls. */
const CUES: Cue[] = [
  { key: "price_sensitivity", delta: 0.3, pattern: /\b(mahal|murah|bajet|budget|diskaun|discount|harga|price|berapa|kos|expensive|cheaper|promo)\b/i },
  { key: "comparison", delta: 0.3, pattern: /\b(banding|compare|agensi lain|other agency|pakej lain|alternative|option lain|versus|vs)\b/i },
  { key: "hesitation", delta: 0.25, pattern: /\b(fikir|pikir|think about|not sure|tak pasti|belum decide|nanti dulu|maybe|mungkin|risau|worried)\b/i },
  { key: "confusion", delta: 0.3, pattern: /\b(tak faham|x faham|confuse[d]?|maksud|apa maksud|boleh ulang|come again|explain|jelaskan)\b/i },
  { key: "frustration", delta: 0.35, pattern: /\b(lambat|slow|kecewa|marah|annoying|frustrated|dah berapa kali|tak puas hati|susah nak)\b/i },
  { key: "urgency", delta: 0.3, pattern: /\b(cepat|segera|urgent|asap|minggu ni|this week|esok|tomorrow|hari ni|today|last minute)\b/i },
  { key: "buying_intent", delta: 0.3, pattern: /\b(nak book|book|tempah|deposit|bayar|payment|confirm|daftar|register|proceed|ambil pakej)\b/i },
  { key: "decision_readiness", delta: 0.3, pattern: /\b(setuju|ok(?:ay)? je|jom|let'?s do|saya ambil|i'?ll take|boleh proceed|confirm)\b/i },
  { key: "interest", delta: 0.2, pattern: /\b(minat|interested|nak tahu|tell me more|detail|boleh terangkan|macam mana|how about)\b/i },
  { key: "trust", delta: 0.2, pattern: /\b(terima kasih|thank you|thanks|bagus|good|helpful|percaya|trust)\b/i },
  { key: "trust", delta: -0.25, pattern: /\b(scam|tipu|betul ke|is this real|tak yakin|not convinced|sure ke)\b/i },
  { key: "reassurance_need", delta: 0.25, pattern: /\b(selamat|safe|jamin|guarantee|refund|cancel|kalau tak jadi|what if|risiko|risk)\b/i },
  { key: "information_overload", delta: 0.25, pattern: /\b(banyak sangat|too much|slow down|perlahan sikit|pening|keliru)\b/i },
];

/** The caller still has outstanding business — termination must be blocked. */
const PENDING_WORK =
  /\b(kejap|sekejap|jap|hold on|wait|tunggu|satu lagi|lagi satu|one more|another question|soalan lagi|belum habis|sebentar)\b/i;

export function callerHasPendingWork(transcript: string | null | undefined): boolean {
  return PENDING_WORK.test(transcript ?? "");
}

/** Signals decay toward neutral so an old cue never dominates a long call. */
function decay(value: number, neutral: number): number {
  return value + (neutral - value) * 0.12;
}

/**
 * One incremental update. Cheap by construction: a regex pass over the newest
 * caller utterance plus a decay step — never a re-scan of the transcript.
 */
export function updateSignals(
  previous: ConversationSignals,
  transcript: string | null | undefined,
): ConversationSignals {
  const next = { ...previous };
  for (const key of KEYS) next[key] = clamp(decay(next[key], NEUTRAL_SIGNALS[key]));

  const text = (transcript ?? "").trim();
  if (!text) return next;

  for (const cue of CUES) {
    if (cue.pattern.test(text)) next[cue.key] = clamp(next[cue.key] + cue.delta);
  }

  // Common sense: a long, engaged utterance is itself an interest signal; a
  // clipped one-word answer is not.
  const words = text.split(/\s+/).length;
  if (words >= 12) next.interest = clamp(next.interest + 0.08);
  if (words <= 2) next.interest = clamp(next.interest - 0.05);

  // Buying intent implies decision readiness moves with it, never past it.
  next.decision_readiness = clamp(Math.max(next.decision_readiness, next.buying_intent - 0.1));
  return next;
}

export function dominantSignals(signals: ConversationSignals, limit = 3): (keyof ConversationSignals)[] {
  return KEYS.filter((k) => signals[k] >= 0.5 && signals[k] > NEUTRAL_SIGNALS[k])
    .sort((a, b) => signals[b] - signals[a])
    .slice(0, limit);
}

const ADAPTATION: Record<keyof ConversationSignals, string> = {
  interest: "The caller is engaged — go one useful step deeper instead of restating basics.",
  hesitation: "The caller is hesitant — lower the pressure, reassure, and offer a small easy next step.",
  confusion: "The caller is unclear — simplify radically, one idea per sentence, no jargon.",
  frustration: "Acknowledge the frustration FIRST in one short sentence, then solve. Do not sell in this turn.",
  urgency: "There is time pressure — lead with the fastest concrete option and confirm timing.",
  trust: "Trust is established — you may be more direct about the next step.",
  price_sensitivity: "Price matters here — frame value and real options clearly, never invent a discount.",
  comparison: "The caller is comparing — state genuine differentiators plainly, never criticise other agencies.",
  decision_readiness: "The caller is close to deciding — make the next action explicit and easy.",
  reassurance_need: "Reassurance is needed — be concrete about what is guaranteed and what is not.",
  information_overload: "Too much detail already — give the single most relevant point and stop.",
  buying_intent: "Buying intent is live — move toward the concrete booking or quotation step now.",
};

/**
 * Behaviour guidance for the prompt. Style only: it tunes tone, pace, length
 * and reassurance, and never introduces facts or overrides RÉNAIO.CORE.
 */
export function adaptationInstruction(signals: ConversationSignals): string[] {
  const dominant = dominantSignals(signals);
  const lines = [
    "CONVERSATIONAL ADAPTATION (style only — the decision stays with your own reasoning):",
    "Speak in 1–3 short spoken clauses. Vary your openers. Never monologue on a live call.",
  ];
  for (const key of dominant) lines.push(`- ${ADAPTATION[key]}`);
  if (dominant.length === 0) {
    lines.push("- Neutral read: stay warm, concise and curious; ask one good question.");
  }
  return lines;
}
