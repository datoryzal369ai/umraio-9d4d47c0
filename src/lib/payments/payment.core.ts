/**
 * UMRAIO® — commercial payment layer, pure logic.
 *
 * No I/O, no env reads, no Supabase. Shared by the payment server helper, the
 * checkout creation path and the Stripe webhook so every commercial rule is
 * testable in isolation.
 *
 * Invariants encoded here:
 *  - a payable amount is ALWAYS derived from authoritative quotation figures,
 *    never from a client-supplied number;
 *  - every checkout carries durable attribution (tenant, lead, quotation,
 *    booking, UMRAIO payment row, payment kind);
 *  - nothing in this module can decide that money arrived — only a
 *    signature-verified Stripe event resolved by `resolveStripePaymentEvent`
 *    can, and even then the server applies it conditionally.
 */

export const PAYMENT_CHECKOUT_KIND = "umraio_payment";

export type PaymentKind = "deposit" | "full";
export type PaymentStatus = "pending" | "succeeded" | "failed" | "expired" | "cancelled";

/** Quotation statuses from which a customer may start a commercial payment. */
export const PAYABLE_QUOTATION_STATUSES = ["accepted", "deposit_pending"] as const;

/** Stripe events this layer acts on. Anything else is ignored by design. */
export const HANDLED_STRIPE_PAYMENT_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.payment_failed",
] as const;

const round2 = (v: number) => Math.round(v * 100) / 100;

export function isPayableQuotationStatus(status: unknown): boolean {
  return (PAYABLE_QUOTATION_STATUSES as readonly string[]).includes(String(status));
}

/**
 * Server-side amount derivation. The client may only choose the KIND; the
 * ringgit figure always comes from the quotation/booking record.
 */
export function resolvePayableAmountMyr(input: {
  kind: PaymentKind;
  totalMyr: number | null | undefined;
  depositMyr?: number | null;
}): number | null {
  const total = Number(input.totalMyr);
  if (!Number.isFinite(total) || total <= 0) return null;

  if (input.kind === "full") return round2(total);

  const deposit = Number(input.depositMyr);
  if (!Number.isFinite(deposit) || deposit <= 0) return null;
  return round2(Math.min(deposit, total));
}

/** Stripe expects the smallest currency unit (MYR sen). */
export function paymentMinorUnits(amountMyr: number): number {
  return Math.round(amountMyr * 100);
}

export type PaymentScope = {
  agencyId: string;
  quotationId: string;
  bookingId: string;
  paymentId: string;
  kind: PaymentKind;
  leadId?: string | null;
};

/** Metadata written on BOTH the Checkout Session and the PaymentIntent. */
export function paymentCheckoutMetadata(scope: PaymentScope): Record<string, string> {
  return {
    kind: PAYMENT_CHECKOUT_KIND,
    payment_kind: scope.kind,
    payment_id: scope.paymentId,
    agency_id: scope.agencyId,
    quotation_id: scope.quotationId,
    booking_id: scope.bookingId,
    ...(scope.leadId ? { lead_id: scope.leadId } : {}),
  };
}

/** Attribution is complete only when every commercial link is present. */
export function hasCompleteAttribution(meta: Record<string, unknown> | null | undefined): boolean {
  const m = meta ?? {};
  return (
    m["kind"] === PAYMENT_CHECKOUT_KIND &&
    (m["payment_kind"] === "deposit" || m["payment_kind"] === "full") &&
    ["payment_id", "agency_id", "quotation_id", "booking_id"].every(
      (key) => typeof m[key] === "string" && String(m[key]).trim().length > 0,
    )
  );
}

export function checkoutProductName(kind: PaymentKind, quotationNumber?: string | null): string {
  const label = kind === "full" ? "Umrah package — full payment" : "Umrah deposit";
  return quotationNumber ? `${label} — ${quotationNumber}` : label;
}

/* ------------------------------ webhook side ------------------------------ */

export type StripeEnvelope = {
  id?: string | null;
  type?: string | null;
  data?: { object?: Record<string, unknown> | null } | null;
};

export type ResolvedPaymentEvent = {
  ok: true;
  eventId: string;
  eventType: string;
  outcome: "succeeded" | "expired" | "failed";
  paymentId: string;
  agencyId: string;
  quotationId: string;
  bookingId: string;
  leadId: string | null;
  kind: PaymentKind;
  paymentRef: string | null;
  amountMinor: number | null;
  amountMyr: number | null;
  failureReason: string | null;
};

export type PaymentEventResolution =
  | ResolvedPaymentEvent
  | { ok: false; reason: "unhandled_event" | "not_umraio_payment" | "not_paid" | "missing_event_id" };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Read a signature-verified Stripe envelope and decide what it means for the
 * UMRAIO payment ledger. Refuses anything that is not a fully attributed
 * UMRAIO commercial payment.
 */
export function resolveStripePaymentEvent(envelope: StripeEnvelope): PaymentEventResolution {
  const eventType = str(envelope.type);
  if (!eventType || !(HANDLED_STRIPE_PAYMENT_EVENTS as readonly string[]).includes(eventType)) {
    return { ok: false, reason: "unhandled_event" };
  }

  const object = (envelope.data?.object ?? {}) as Record<string, unknown>;
  const meta = (object["metadata"] ?? {}) as Record<string, unknown>;
  if (!hasCompleteAttribution(meta)) return { ok: false, reason: "not_umraio_payment" };

  const eventId = str(envelope.id);
  if (!eventId) return { ok: false, reason: "missing_event_id" };

  let outcome: ResolvedPaymentEvent["outcome"];
  let paymentRef: string | null;
  let failureReason: string | null = null;

  if (eventType === "checkout.session.completed") {
    // A reached / completed Checkout page proves nothing. Only `paid` does.
    if (object["payment_status"] !== "paid") return { ok: false, reason: "not_paid" };
    outcome = "succeeded";
    paymentRef = str(object["payment_intent"]) ?? str(object["id"]);
  } else if (eventType === "checkout.session.expired") {
    outcome = "expired";
    paymentRef = str(object["id"]);
    failureReason = "checkout_expired";
  } else {
    outcome = "failed";
    paymentRef = str(object["id"]);
    const lastError = (object["last_payment_error"] ?? {}) as Record<string, unknown>;
    failureReason = str(lastError["code"]) ?? str(lastError["message"]) ?? "payment_failed";
  }

  const rawMinor = object["amount_total"] ?? object["amount"];
  const amountMinor = typeof rawMinor === "number" ? Math.round(rawMinor) : null;

  return {
    ok: true,
    eventId,
    eventType,
    outcome,
    paymentId: String(meta["payment_id"]),
    agencyId: String(meta["agency_id"]),
    quotationId: String(meta["quotation_id"]),
    bookingId: String(meta["booking_id"]),
    leadId: str(meta["lead_id"]),
    kind: meta["payment_kind"] === "full" ? "full" : "deposit",
    paymentRef,
    amountMinor,
    amountMyr: amountMinor === null ? null : round2(amountMinor / 100),
    failureReason,
  };
}

/** Terminal commercial state for a resolved event. */
export function paymentStatusForOutcome(outcome: ResolvedPaymentEvent["outcome"]): PaymentStatus {
  return outcome === "succeeded" ? "succeeded" : outcome === "expired" ? "expired" : "failed";
}
