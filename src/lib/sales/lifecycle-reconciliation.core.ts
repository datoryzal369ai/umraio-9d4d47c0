/**
 * UMRAIO® — SALES STATE RECONCILIATION (pure core).
 *
 * One authoritative answer to a single question: what is the strongest VERIFIED
 * commercial lifecycle evidence for this lead right now?
 *
 * Two governance rules follow from it:
 *
 * 1. A communication opt-out (STOP / do-not-contact) is a SAFETY dimension. It
 *    must never destroy a stronger verified commercial state such as a
 *    confirmed booking. Consent and commerce are independent axes.
 * 2. A customer-initiated recovery must derive the commercial stage from that
 *    evidence, never blindly reset it to "contacted".
 *
 * No new lifecycle states are invented here — only the canonical
 * `leads.stage` values already used by UMRAIO.
 */

/** Canonical lead stages already in use (public.leads.stage). */
export type LeadStage =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "booked"
  | "completed"
  | "lost";

/** Quotation statuses that represent a LIVE commercial conversation. */
const ACTIVE_QUOTATION_STATUSES = new Set([
  "ready",
  "sent",
  "viewed",
  "discussing",
  "accepted",
  "deposit_pending",
]);

/** Quotation statuses that mean the customer already committed. */
const COMMITTED_QUOTATION_STATUSES = new Set(["accepted", "deposit_pending"]);

/** Booking statuses that count as a confirmed commercial outcome. */
const CONFIRMED_BOOKING_STATUSES = new Set(["confirmed", "booked", "paid", "completed"]);

/** Lead stages that are terminal commercial WINS and must never be downgraded. */
const TERMINAL_COMMERCIAL_STAGES = new Set<LeadStage>(["booked", "completed"]);

export type LifecycleEvidence = {
  /** Current persisted lead stage (may be stale). */
  leadStage?: string | null;
  /** Status of the newest booking row for this lead, if any. */
  bookingStatus?: string | null;
  /** Status of the live quotation for this lead, if any. */
  quotationStatus?: string | null;
  /** True when the lead has enough qualifying facts to be a real prospect. */
  qualified?: boolean;
};

export function hasConfirmedBooking(evidence: LifecycleEvidence): boolean {
  const status = (evidence.bookingStatus ?? "").toLowerCase();
  if (status && CONFIRMED_BOOKING_STATUSES.has(status)) return true;
  const stage = (evidence.leadStage ?? "").toLowerCase() as LeadStage;
  return TERMINAL_COMMERCIAL_STAGES.has(stage);
}

export function hasActiveQuotation(evidence: LifecycleEvidence): boolean {
  const status = (evidence.quotationStatus ?? "").toLowerCase();
  return Boolean(status) && ACTIVE_QUOTATION_STATUSES.has(status);
}

/**
 * A terminal commercial state is a verified WIN. An opt-out never rewrites it
 * to "lost" — the STOP is recorded on the governance fields instead.
 */
export function isTerminalCommercialState(evidence: LifecycleEvidence): boolean {
  return hasConfirmedBooking(evidence);
}

/**
 * Stage to persist when a customer OPTS OUT.
 * `null` means "leave the stage exactly as it is".
 */
export function resolveOptOutStage(evidence: LifecycleEvidence): LeadStage | null {
  if (isTerminalCommercialState(evidence)) return null;
  return "lost";
}

/**
 * Stage to persist when an eligible customer-initiated inbound turn recovers a
 * conversation. `null` means "leave the stage exactly as it is" — recovery
 * never downgrades a lead that is already further along.
 */
export function resolveRecoveryStage(evidence: LifecycleEvidence): LeadStage | null {
  const current = (evidence.leadStage ?? "").toLowerCase();

  // Strongest evidence first.
  if (hasConfirmedBooking(evidence)) return current === "completed" ? null : "booked";

  // Only a stage that was wiped to "lost" (or is otherwise weaker) is restored.
  if (current !== "lost" && current !== "new" && current !== "") return null;

  const quotation = (evidence.quotationStatus ?? "").toLowerCase();
  if (quotation && COMMITTED_QUOTATION_STATUSES.has(quotation)) return "negotiation";
  if (hasActiveQuotation(evidence)) return "proposal";
  if (evidence.qualified) return "qualified";
  return "contacted";
}

/**
 * Deterministic guard used by conversation intelligence: a persisted
 * `stage='lost'` must not win when stronger current evidence contradicts it.
 */
export function lostStageIsContradicted(evidence: LifecycleEvidence): boolean {
  return hasConfirmedBooking(evidence) || hasActiveQuotation(evidence);
}

/** The single governed patch applied when a customer re-initiates contact. */
export function buildRecoveryConversationPatch(now: string) {
  return {
    ai_enabled: true,
    conversation_state: "ACTIVE",
    state_updated_at: now,
    human_attention_required: false,
    escalated_at: null as string | null,
    escalation_reason: null as string | null,
  };
}

/** The single governed patch applied when the owner resumes the AI. */
export function buildOwnerResumeConversationPatch(now: string) {
  return {
    ai_enabled: true,
    // Replay cut-off: muted-era messages are history, never answered.
    ai_muted_at: now,
    ai_reply_claimed_at: null as string | null,
    ai_reply_due_at: null as string | null,
    human_attention_required: false,
    escalated_at: null as string | null,
    escalation_reason: null as string | null,
    conversation_state: "ACTIVE",
    state_updated_at: now,
    status: "open",
  };
}
