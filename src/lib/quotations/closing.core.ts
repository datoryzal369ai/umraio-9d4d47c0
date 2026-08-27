/**
 * AI QUOTATION EXECUTIVE™ — deterministic closing helpers.
 *
 * Pure functions only (no I/O), so both the WhatsApp path and tests can use
 * them. Two jobs:
 *  1. When the customer clearly wants a quotation but a required input is
 *     missing, tell the model EXACTLY which input to ask for (one question).
 *  2. Detect an explicit in-chat acceptance of a quotation that was already
 *     sent, so the row can transition without waiting for the public link.
 */

import { detectBuyingSignals } from "../sales-intent.core";

export type MissingQuotationInput = "package" | "pax";

export function missingQuotationInputs(input: {
  packageInterest?: string | null;
  pax?: number | null;
  latestMessage?: string | null;
}): MissingQuotationInput[] {
  const signals = detectBuyingSignals(input.latestMessage);
  const missing: MissingQuotationInput[] = [];
  if (!input.packageInterest && !signals.includes("CHOSE_PACKAGE")) missing.push("package");
  if (!(input.pax && input.pax > 0) && !signals.includes("CONFIRMED_PAX")) missing.push("pax");
  return missing;
}

/** True when the customer asked to close but we still lack a required input. */
export function closingIntentDetected(latestMessage: string | null | undefined): boolean {
  const signals = detectBuyingSignals(latestMessage);
  return (
    signals.includes("READY_TO_BOOK") ||
    signals.includes("ASKED_FOR_QUOTATION") ||
    signals.includes("ASKED_HOW_TO_PAY")
  );
}

const MISSING_QUESTION: Record<MissingQuotationInput, string> = {
  package: "which package they want (name the shortlisted packages with their prices)",
  pax: "how many pilgrims (pax) the quotation is for",
};

/** Short auditable directive appended to the system prompt. */
export function missingQuotationInputInstruction(input: {
  packageInterest?: string | null;
  pax?: number | null;
  latestMessage?: string | null;
}): string | null {
  if (!closingIntentDetected(input.latestMessage)) return null;
  const missing = missingQuotationInputs(input);
  if (!missing.length) return null;
  return [
    "QUOTATION BLOCKED — MISSING INPUT:",
    `You cannot call create_quotation yet. Ask ONE short question to get ${MISSING_QUESTION[missing[0]!]}.`,
    missing.length > 1
      ? `Still missing after that: ${missing.slice(1).map((m) => MISSING_QUESTION[m]).join("; ")}. Ask for it on the next turn, not now.`
      : "",
    "Do not guess the missing value, do not quote a total, and do not stall — ask, then close.",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* In-chat acceptance                                                  */
/* ------------------------------------------------------------------ */

const ACCEPT_PATTERNS: RegExp[] = [
  /\b(saya\s+)?setuju\b/i,
  /\bok(ay)?\s*(la|lah)?\s*(saya\s+)?(nak|ambil|proceed|teruskan|confirm)\b/i,
  /\b(nak|mahu)\s+(ambil|proceed|teruskan|book(ing)?)\b/i,
  /\bteruskan\b/i,
  /\bsaya\s+ambil\b/i,
  /\bconfirm(kan)?\b/i,
  /\b(i\s+)?accept\b/i,
  /\bdeal\b/i,
  /\bgo\s+ahead\b/i,
  /\bproceed\b/i,
  /\b(boleh|ok)\s*,?\s*(bila|macam\s+mana)?\s*(bayar|deposit)\b/i,
];

const REJECT_PATTERNS: RegExp[] = [
  /\btak\s+(jadi|nak|mahu|setuju)\b/i,
  /\bcancel\b/i,
  /\bbatal\b/i,
  /\bnanti\s+dulu\b/i,
  /\bfikir\s+dulu\b/i,
  /\btunggu\s+dulu\b/i,
  /\bmahal\b/i,
  /\bnot\s+now\b/i,
];

/**
 * Only a clear, unambiguous acceptance counts. A bare "boleh" is NOT enough —
 * it is used constantly in Malay as "sure/ok, go on" mid-conversation.
 */
export function detectQuotationAcceptance(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  if (REJECT_PATTERNS.some((re) => re.test(t))) return false;
  return ACCEPT_PATTERNS.some((re) => re.test(t));
}

/* ------------------------------------------------------------------ */
/* P0-4 — empty AI completion fallbacks (never the ASR apology)        */
/* ------------------------------------------------------------------ */

/** Neutral holding reply for a genuinely empty AI completion (text turn). */
export const EMPTY_COMPLETION_HOLDING_MESSAGE =
  "Sekejap Dato', saya semak dan balas sebentar lagi.";

export type ToolRejectionRecord = {
  tool: string;
  status: string;
  reason?: string | null;
};

/** True when the last create_quotation attempt was blocked by a live quotation. */
export function isLiveQuotationRejection(records: ToolRejectionRecord[]): boolean {
  const last = [...records].reverse().find((r) => r.tool === "create_quotation");
  if (!last || last.status === "executed") return false;
  return /already has a live quotation/i.test(last.reason ?? "");
}

export type ExistingQuotationFacts = {
  quotationNumber?: string | null;
  status?: string | null;
  totalMyr?: number | null;
};

/** Deterministic, honest reply: the existing quotation is still live. */
export function existingQuotationReply(facts: ExistingQuotationFacts | null): string {
  const details: string[] = [];
  if (facts?.quotationNumber) details.push(`Quotation ${facts.quotationNumber}`);
  if (typeof facts?.totalMyr === "number" && Number.isFinite(facts.totalMyr)) {
    details.push(`jumlah RM${facts.totalMyr.toLocaleString("en-MY")}`);
  }
  const detailLine = details.length ? ` (${details.join(", ")})` : "";
  return [
    `Baik Dato'. Quotation sedia ada${detailLine} masih aktif, jadi saya tak keluarkan yang baharu.`,
    "Saya boleh bantu semak semula butirannya atau teruskan ke langkah seterusnya.",
    "Dato' nak saya semak dulu, atau terus ke langkah seterusnya?",
  ].join(" ");
}

/**
 * Chooses the reply for an EMPTY AI completion on a normal (non-ASR) turn.
 * The voice/ASR apology is never produced here.
 */
export function emptyCompletionReply(input: {
  toolRecords: ToolRejectionRecord[];
  quotation?: ExistingQuotationFacts | null;
}): string {
  if (isLiveQuotationRejection(input.toolRecords)) {
    return existingQuotationReply(input.quotation ?? null);
  }
  return EMPTY_COMPLETION_HOLDING_MESSAGE;
}
