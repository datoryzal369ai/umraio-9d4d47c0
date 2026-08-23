/**
 * ISLAMIC IMPLEMENTATION LAYER™ — review domain (pure core).
 *
 * Deliberately separate from AI SALES ELITE™ approvals and from generic
 * `ai_tasks`. Nothing in this module touches the network or the database, so
 * the whole state machine is unit-testable and deterministic.
 */

export const ISLAMIC_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED", "AMENDED"] as const;
export type IslamicReviewStatus = (typeof ISLAMIC_REVIEW_STATUSES)[number];

/** Statuses that still occupy the review queue (no duplicate may be created). */
export const OPEN_ISLAMIC_REVIEW_STATUSES: readonly IslamicReviewStatus[] = ["PENDING", "AMENDED"];

export type IslamicReviewDecision = "approve" | "amend" | "reject";

/** Server-authoritative transition table. Anything absent is invalid. */
const TRANSITIONS: Record<IslamicReviewStatus, readonly IslamicReviewStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "AMENDED"],
  AMENDED: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

export function isOpenIslamicReview(status: string): boolean {
  return OPEN_ISLAMIC_REVIEW_STATUSES.includes(status as IslamicReviewStatus);
}

/**
 * A pending review may affect only the inbound turn that created it. Reviews
 * opened before this turn remain in the human queue but cannot mute a later,
 * unrelated reply in the same conversation.
 */
export function isCurrentTurnIslamicReviewPending(
  review: { status: string; created_at: string; question?: string | null } | null,
  inboundAt: Date | string,
  currentQuestion?: string | null,
): boolean {
  if (!review || !isOpenIslamicReview(review.status)) return false;
  if (currentQuestion !== undefined) {
    const normalise = (value: string | null | undefined) =>
      (value ?? "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const reviewQuestion = normalise(review.question);
    const inboundQuestion = normalise(currentQuestion);
    return Boolean(reviewQuestion) && reviewQuestion === inboundQuestion;
  }
  const reviewCreatedAt = Date.parse(review.created_at);
  const turnStartedAt = inboundAt instanceof Date ? inboundAt.getTime() : Date.parse(inboundAt);
  return Number.isFinite(reviewCreatedAt) && Number.isFinite(turnStartedAt) && reviewCreatedAt >= turnStartedAt;
}

export function nextStatusFor(decision: IslamicReviewDecision): IslamicReviewStatus {
  return decision === "approve" ? "APPROVED" : decision === "amend" ? "AMENDED" : "REJECTED";
}

export function canTransition(from: string, to: IslamicReviewStatus): boolean {
  const allowed = TRANSITIONS[from as IslamicReviewStatus];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Roles permitted to decide Islamic content. Sales roles alone are not enough. */
export const ISLAMIC_APPROVER_ROLES = ["owner", "admin", "islamic_approver"] as const;

export function canDecideIslamicReview(roles: readonly string[] | null | undefined): boolean {
  if (!roles?.length) return false;
  return roles.some((r) => (ISLAMIC_APPROVER_ROLES as readonly string[]).includes(r));
}

/**
 * Deterministic dedupe key: same topic + same normalised question in the same
 * conversation is the SAME religious request, however it is re-phrased in
 * whitespace/punctuation/casing terms.
 */
export function islamicDedupeKey(topic: string, question: string): string {
  const normalisedTopic = (topic || "other").trim().toLowerCase();
  const normalisedQuestion = (question || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `${normalisedTopic}:${normalisedQuestion}`;
}

export type DecisionInput = {
  currentStatus: string;
  decision: IslamicReviewDecision;
  approvedAnswer?: string | null;
  amendmentNotes?: string | null;
  rejectionReason?: string | null;
};

export type DecisionValidation =
  | { ok: true; nextStatus: IslamicReviewStatus }
  | { ok: false; reason: string };

/** Validate a decision BEFORE any write. Client input is never trusted. */
export function validateDecision(input: DecisionInput): DecisionValidation {
  const nextStatus = nextStatusFor(input.decision);
  if (!canTransition(input.currentStatus, nextStatus)) {
    return {
      ok: false,
      reason: `Invalid transition ${input.currentStatus} → ${nextStatus}`,
    };
  }
  if (input.decision === "approve" && !(input.approvedAnswer ?? "").trim()) {
    return { ok: false, reason: "An approved answer is required." };
  }
  if (input.decision === "amend" && !(input.amendmentNotes ?? "").trim()) {
    return { ok: false, reason: "An amended answer is required." };
  }
  if (input.decision === "reject" && !(input.rejectionReason ?? "").trim()) {
    return { ok: false, reason: "A rejection reason is required." };
  }
  return { ok: true, nextStatus };
}

/**
 * LOOP BREAKER — one concise holding response, then contextual
 * acknowledgement. Never re-asks the customer to confirm the same request.
 */
export const ISLAMIC_HOLDING_MESSAGE =
  "Baik Datuk, soalan itu saya dah terima. Saya sedang dapatkan semakan daripada pembimbing agama supaya jawapan yang saya beri betul dan bersumber. Sebaik sahaja disahkan, saya sambung semula dengan jawapannya. Sementara itu saya boleh teruskan bantu untuk pakej dan tarikh.";

export const ISLAMIC_PENDING_ACK_MESSAGE =
  "Soalan agama tadi masih dalam semakan pembimbing agama, Datuk — saya akan kembali dengan jawapannya. Sementara menunggu, saya boleh teruskan bantu untuk pakej, tarikh dan harga.";

export function rejectionMessage(): string {
  return "Mohon maaf Datuk, jawapan untuk soalan agama tadi tidak dapat disahkan oleh pembimbing agama kami, jadi saya tidak akan memberi hukum sendiri. Untuk kepastian, elok dirujuk terus kepada pihak berautoriti agama. Saya tetap boleh bantu Datuk untuk urusan pakej dan perjalanan.";
}

export type PendingReplyPlan =
  | { kind: "none" }
  | { kind: "holding"; message: string; markHoldingSent: true }
  | { kind: "acknowledge"; message: string };

/**
 * Decide what to send when an Islamic review is already open for this
 * conversation. Guarantees exactly ONE holding response per review.
 */
export function planPendingReviewReply(review: {
  status: string;
  holding_sent_at?: string | null;
} | null): PendingReplyPlan {
  if (!review || !isOpenIslamicReview(review.status)) return { kind: "none" };
  if (!review.holding_sent_at) {
    return { kind: "holding", message: ISLAMIC_HOLDING_MESSAGE, markHoldingSent: true };
  }
  return { kind: "acknowledge", message: ISLAMIC_PENDING_ACK_MESSAGE };
}

/** Audit event names for the Islamic domain (IDs only — never PII). */
export const ISLAMIC_AUDIT_EVENTS = {
  created: "islamic_review_created",
  deduplicated: "islamic_review_deduplicated",
  approved: "islamic_review_approved",
  amended: "islamic_review_amended",
  rejected: "islamic_review_rejected",
  deliveryStarted: "islamic_review_delivery_started",
  deliverySucceeded: "islamic_review_delivery_succeeded",
  deliveryFailed: "islamic_review_delivery_failed",
} as const;
