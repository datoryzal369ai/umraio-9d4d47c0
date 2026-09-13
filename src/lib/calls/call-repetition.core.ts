/**
 * UMRAIO® — CALLING ANTI-REPETITION (pure core).
 *
 * A live caller experiences a repeated substantive answer as "pusing-pusing":
 * the same history/number/explanation returned turn after turn. Model output
 * and the deterministic recovery paths can both produce it. This module is the
 * last conservative guard: it never suppresses a genuinely new answer, and it
 * never fires when the caller explicitly asked for a repeat.
 *
 * Pure: no I/O, no model calls, no fabricated facts.
 */

/** Caller explicitly wants the same content again — repetition is then correct. */
const REPEAT_REQUEST =
  /\b(?:ulang(?:kan|i)?(?:\s+(?:sekali|balik|semula))?|sekali\s+lagi|boleh\s+ulang|apa\s+(?:tadi|dia)|say\s+(?:that\s+)?again|repeat(?:\s+that)?|come\s+again|once\s+more)\b/i;

export function requestsRepetition(transcript: string): boolean {
  return REPEAT_REQUEST.test(transcript.trim());
}

export function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalizeSpoken(text).split(" ").filter(Boolean));
}

/**
 * Substantial overlap, not exact equality: a model re-explaining the same
 * history/number with slightly different wording is the live defect.
 */
export function speechOverlap(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

/** Very short utterances (acknowledgements, farewells) are not "repeated answers". */
export function repeatsPreviousSpeech(candidate: string, previous: string[], threshold = 0.8): boolean {
  const normalized = normalizeSpoken(candidate);
  if (normalized.split(" ").filter(Boolean).length < 5) return false;
  return previous.some(prior => {
    const priorNormalized = normalizeSpoken(prior);
    if (!priorNormalized) return false;
    return priorNormalized === normalized || speechOverlap(candidate, prior) >= threshold;
  });
}

const FORWARD_MS = [
  "Maaf, saya dah terangkan bahagian itu tadi. Bahagian mana yang{title} nak saya fokuskan?",
  "Supaya tak berulang, boleh{title} beritahu satu perkara khusus yang{title} nak saya jelaskan?",
  "Saya tak nak ulang benda yang sama. Apa yang{title} nak saya bantu seterusnya?",
];
const FORWARD_EN = [
  "I've already covered that part. Which part would you like me to focus on{title}?",
  "So I don't repeat myself, could you tell me the one thing you'd like me to explain{title}?",
  "I won't repeat the same point. What would you like me to help with next{title}?",
];

/**
 * One concise, claim-free, forward-moving clarification used INSTEAD of a
 * repeat. It asserts no business fact and asks exactly one question.
 */
export function forwardMovingResponse(language: string, honorific: string | null, seed: number): string {
  const list = language.toLowerCase().startsWith("en") ? FORWARD_EN : FORWARD_MS;
  const text = list[Math.abs(seed) % list.length] as string;
  return text.replace(/\{title\}/g, honorific ? ` ${honorific}` : "");
}
