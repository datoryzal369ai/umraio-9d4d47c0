/**
 * UMRAIO® — CONVERSATIONAL VALIDATION GUARD (pure core).
 *
 * "Understand first. Infer when safe. Confirm only when necessary."
 *
 * Deterministic, dependency-free helpers that stop the sales brain from
 * re-asking questions the conversation has already answered. Nothing here
 * touches the database, the model, media retrieval or document processing —
 * it only produces a small, auditable instruction block plus telemetry labels.
 */

export type ContinuityModality = "text" | "audio" | "image";

export type ContinuityTurn = {
  sender: string;
  body: string;
};

/** Affirmations that resolve against the immediately preceding question. */
const AFFIRMATIVE =
  /^(ya|yaa+|ye|yes|yup|yep|ok(ay|e|ey)?|oke?y|betul|betul\s+tu|baik|baiklah|boleh|setuju|sure|of\s+course|confirm|ha'?ah|aah|haah|right|correct|tepat|silakan|silalah|sila|please\s+do|go\s+ahead|teruskan|lanjutkan)\b/i;

/** Explicit negatives — never treat these as consent to proceed. */
const NEGATIVE =
  /^(tak|tidak|no|nope|bukan|jangan|belum|nanti\s+dulu|not\s+now|tak\s+payah|tak\s+nak)\b/i;

/**
 * Consequential = irreversible, financial, booking-related or data-changing.
 * These always keep an explicit confirmation step.
 */
const CONSEQUENTIAL =
  /\b(bayar|bayaran|payment|deposit|transfer|invois|invoice|tempah(an)?|book(ing)?|confirm\s+booking|daftar|register|batal|cancel|refund|tukar\s+tarikh|reschedule|kad\s+kredit|credit\s+card)\b/i;

/** Visual/document context the customer has explicitly asked us to interpret. */
const ANALYSE_REQUEST =
  /\b(ulas|ulasan|review|semak|analisa|analisis|analyse|analyze|terangkan|explain|apa\s+(ni|itu|tu|ini)|maksud|comment|pendapat)\b/i;

const QR_MENTION = /\b(qr|kod\s*qr|qr\s*code|scan)\b/i;

export function isAffirmative(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (t.length > 40) return false;
  if (NEGATIVE.test(t)) return false;
  return AFFIRMATIVE.test(t);
}

export function isNegative(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return Boolean(t) && NEGATIVE.test(t);
}

export function isConsequentialAction(text: string | null | undefined): boolean {
  return Boolean(text) && CONSEQUENTIAL.test(text as string);
}

/** The last question UMRAIO (or a human colleague) asked, if any. */
export function lastPendingQuestion(turns: ReadonlyArray<ContinuityTurn>): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.sender === "customer") continue;
    const body = (turn.body ?? "").trim();
    if (!body.includes("?")) return null;
    const sentences = body
      .split(/(?<=\?)\s+/)
      .map((s) => s.trim())
      .filter((s) => s.endsWith("?"));
    return sentences.length ? sentences[sentences.length - 1]! : null;
  }
  return null;
}

/**
 * How many times in a row UMRAIO has asked a question without the customer's
 * answer being acted upon. Two or more = a clarification loop worth breaking.
 */
export function consecutiveClarifications(turns: ReadonlyArray<ContinuityTurn>): number {
  let streak = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.sender === "customer") continue;
    if ((turn.body ?? "").includes("?")) streak += 1;
    else break;
    if (streak >= 4) break;
  }
  return streak;
}


export type ContinuityRead = {
  pendingQuestion: string | null;
  affirmativeResolved: boolean;
  intentStatus: "resolved" | "open";
  clarificationLoopRisk: boolean;
  requiresConfirmation: boolean;
  analysisRequested: boolean;
  qrPresent: boolean;
  modality: ContinuityModality;
  telemetry: string[];
};

export function readContinuity(input: {
  turns: ReadonlyArray<ContinuityTurn>;
  latestCustomerMessage: string | null | undefined;
  modality?: ContinuityModality;
}): ContinuityRead {
  const modality = input.modality ?? "text";
  const latest = (input.latestCustomerMessage ?? "").trim();
  const pendingQuestion = lastPendingQuestion(input.turns);
  const affirmative = isAffirmative(latest);
  const affirmativeResolved = affirmative && Boolean(pendingQuestion);
  const loops = consecutiveClarifications(input.turns);
  const requiresConfirmation =
    isConsequentialAction(latest) || isConsequentialAction(pendingQuestion ?? "");
  const analysisRequested = ANALYSE_REQUEST.test(latest) || modality === "image";
  const qrPresent = QR_MENTION.test(latest);

  const telemetry: string[] = [];
  if (affirmativeResolved) telemetry.push("affirmative_context_resolved");
  if (affirmativeResolved || (analysisRequested && modality === "image")) {
    telemetry.push("intent_resolved_from_context", "clarification_avoided");
  }
  if (loops >= 2) telemetry.push("clarification_loop_risk");
  if (!affirmativeResolved && !analysisRequested && !latest) {
    telemetry.push("clarification_requested");
  }

  return {
    pendingQuestion,
    affirmativeResolved,
    intentStatus: affirmativeResolved || analysisRequested ? "resolved" : "open",
    clarificationLoopRisk: loops >= 2,
    requiresConfirmation,
    analysisRequested,
    qrPresent,
    modality,
    telemetry,
  };
}

/** Prompt block appended to the system prompt. Short, auditable, no PII. */
export function continuityInstruction(read: ContinuityRead): string {
  const lines: string[] = [
    "CONVERSATIONAL VALIDATION GUARD (high priority): understand first, infer when safe, confirm only when necessary. Never ask the customer for anything that is already reasonably inferable from this conversation, the previous question you asked, the detected intent or the attached media.",
    "Ask AT MOST ONE clarification question per reply, and only when the ambiguity materially changes what you would do. Otherwise give the useful answer first and offer the next step.",
    "Never re-validate an intent that is already resolved, and never re-ask the same question in different wording unless the customer contradicts themselves.",
  ];

  if (read.affirmativeResolved && read.pendingQuestion) {
    lines.push(
      `AFFIRMATIVE BINDING: the customer's reply is an affirmation of YOUR immediately preceding question: "${read.pendingQuestion.slice(0, 240)}". Treat it as YES to that exact question, continue with that action, and do NOT restart intent discovery.`,
    );
  }
  if (read.clarificationLoopRisk) {
    lines.push(
      "LOOP BREAKER: you have asked consecutive questions already. This reply must deliver concrete value (information, options, or the requested action) — do not ask another question unless it is genuinely blocking.",
    );
  }
  if (read.modality === "image") {
    lines.push(
      "VISUAL CONTEXT: an image/poster observation is part of this turn. Begin with a useful reading of what is visible before asking anything. Do not ask what the image is about when the observation already answers it.",
    );
    if (read.qrPresent) {
      lines.push(
        "A QR code was mentioned or visible. Do NOT turn that into a clarification loop — only act on the QR when the customer explicitly asks for an action involving it.",
      );
    }
  }
  if (read.modality === "audio") {
    lines.push(
      "VOICE CONTEXT: the transcript is a continuation of this conversation, not a brand-new intent. Combine it with what is already known.",
    );
  }
  if (read.requiresConfirmation) {
    lines.push(
      "CONSEQUENTIAL ACTION: this turn touches booking, payment, deposit, cancellation or a change to customer records. Ask exactly ONE concise confirmation before proceeding — correctness outweighs speed here.",
    );
  } else {
    lines.push(
      "LOW-RISK TURN: prefer a best-effort inference and a helpful answer over another question.",
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Humanised response timing (UX targets, never artificial slowness).
 * ------------------------------------------------------------------ */

export type LatencyBucket = "instant" | "short" | "normal" | "considered" | "complex";

const TARGET_MIN_MS: Record<LatencyBucket, number> = {
  instant: 1_200,
  short: 1_500,
  normal: 2_500,
  considered: 3_000,
  complex: 4_000,
};

export function latencyBucket(input: {
  modality: ContinuityModality;
  replyLength: number;
}): LatencyBucket {
  if (input.modality === "image") return "considered";
  if (input.modality === "audio") return "considered";
  if (input.replyLength <= 90) return "short";
  if (input.replyLength >= 600) return "complex";
  return "normal";
}

/**
 * Small natural presentation delay used ONLY when real processing finished
 * faster than a human executive plausibly could. Capped so it can never make
 * UMRAIO feel slow.
 */
export function presentationDelayMs(input: {
  elapsedMs: number;
  modality: ContinuityModality;
  replyLength: number;
  maxMs?: number;
}): number {
  const bucket = latencyBucket({ modality: input.modality, replyLength: input.replyLength });
  const target = TARGET_MIN_MS[bucket];
  const max = input.maxMs ?? 1_500;
  return Math.max(0, Math.min(max, target - Math.max(0, input.elapsedMs)));
}

export function latencyBucketLabel(elapsedMs: number): string {
  if (elapsedMs < 2_000) return "lt_2s";
  if (elapsedMs < 4_000) return "2_4s";
  if (elapsedMs < 6_000) return "4_6s";
  if (elapsedMs < 8_000) return "6_8s";
  return "gt_8s";
}
