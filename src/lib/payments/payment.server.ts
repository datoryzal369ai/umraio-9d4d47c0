/**
 * UMRAIO® — commercial payment layer (server-only).
 *
 * Responsibilities:
 *  1. Create an attributed UMRAIO payment row + Stripe-hosted Checkout session
 *     for a quotation, with the amount derived on the server.
 *  2. Apply signature-verified Stripe events to the ledger idempotently.
 *
 * Financial writes run with the service role and are always conditional on the
 * tenant (`agency_id`) and on the row still being `pending`, so a replayed
 * webhook, a cross-tenant metadata forgery or a concurrent delivery can never
 * duplicate a transition.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logConversionEvent } from "@/lib/conversion/events";
import { markDepositPaid, ensureBookingForAcceptedQuotation } from "@/lib/bookings/booking.server";
import {
  isPayableQuotationStatus,
  paymentMinorUnits,
  paymentStatusForOutcome,
  resolvePayableAmountMyr,
  type PaymentKind,
  type ResolvedPaymentEvent,
} from "@/lib/payments/payment.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export type StartPaymentResult =
  | { ok: true; url: string; paymentId: string; amountMyr: number; kind: PaymentKind; resumed: boolean }
  | {
      ok: false;
      reason:
        | "quotation_not_found"
        | "not_payable"
        | "no_amount"
        | "already_paid"
        | "booking_unavailable"
        | "provider_unavailable";
    };

/**
 * A booking may only ever have ONE live checkout. Starting a deposit while a
 * full-payment page is still open (or the reverse) would allow the customer to
 * complete both and be charged twice. The superseded attempt is cancelled here
 * and its Stripe session is expired so the abandoned tab can no longer pay.
 */
async function retirePendingPayments(
  supabase: Db,
  input: { agencyId: string; bookingId: string; kind: PaymentKind; reason: string },
): Promise<void> {
  const { data: rows } = await supabase
    .from("payments")
    .select("id, checkout_session_id")
    .eq("agency_id", input.agencyId)
    .eq("booking_id", input.bookingId)
    .eq("kind", input.kind)
    .eq("status", "pending");

  for (const row of (rows ?? []) as Array<Record<string, any>>) {
    const { data: cancelled } = await supabase
      .from("payments")
      .update({ status: "cancelled", failure_reason: input.reason })
      .eq("id", row["id"])
      .eq("agency_id", input.agencyId)
      .eq("status", "pending")
      .select("id");
    if (!((cancelled ?? []) as unknown[]).length) continue;

    const sessionId = row["checkout_session_id"];
    if (!sessionId) continue;
    try {
      const { stripeFetch } = await import("@/lib/stripe.server");
      await stripeFetch(`/checkout/sessions/${String(sessionId)}/expire`, { method: "POST" });
    } catch (error) {
      console.error("[payment] expire_session_failed", (error as Error).message);
    }
  }
}

/** Any settled payment on the booking closes the booking to further checkouts. */
async function settledPaymentFor(
  supabase: Db,
  input: { agencyId: string; bookingId: string },
): Promise<Record<string, any> | null> {
  const { data } = await supabase
    .from("payments")
    .select("id, kind, status")
    .eq("agency_id", input.agencyId)
    .eq("booking_id", input.bookingId)
    .eq("status", "succeeded")
    .limit(1);
  return ((data ?? []) as Array<Record<string, any>>)[0] ?? null;
}

/**
 * Create (or resume) a Stripe Checkout for a quotation identified by its
 * public token. Nothing about price, currency or tenant comes from the client.
 */
export async function startQuotationPayment(
  supabase: Db,
  input: { token: string; kind: PaymentKind; customerEmail?: string | null },
): Promise<StartPaymentResult> {
  const { data: quotation } = await supabase
    .from("quotations")
    .select(
      "id, agency_id, lead_id, status, total, deposit_amount, quotation_number, public_token, currency",
    )
    .eq("public_token", input.token)
    .maybeSingle();

  if (!quotation) return { ok: false, reason: "quotation_not_found" };
  if (!isPayableQuotationStatus(quotation.status)) return { ok: false, reason: "not_payable" };

  const booking = await ensureBookingForAcceptedQuotation(supabase, {
    agencyId: quotation.agency_id,
    quotationId: quotation.id,
    actor: "customer",
  });
  if (!booking.ok) return { ok: false, reason: "booking_unavailable" };

  const amountMyr = resolvePayableAmountMyr({
    kind: input.kind,
    totalMyr: num(quotation.total),
    depositMyr: booking.depositMyr ?? num(quotation.deposit_amount),
  });
  if (!amountMyr) return { ok: false, reason: "no_amount" };
  const amountMinor = paymentMinorUnits(amountMyr);

  // Resume an identical pending attempt instead of creating a second one.
  const { data: pendingRows } = await supabase
    .from("payments")
    .select("id, amount_minor, checkout_url, status")
    .eq("agency_id", quotation.agency_id)
    .eq("booking_id", booking.booking.id)
    .eq("kind", input.kind)
    .eq("status", "pending")
    .limit(1);
  const pending = ((pendingRows ?? []) as Array<Record<string, any>>)[0];
  if (pending?.["checkout_url"] && Number(pending["amount_minor"]) === amountMinor) {
    return {
      ok: true,
      url: String(pending["checkout_url"]),
      paymentId: String(pending["id"]),
      amountMyr,
      kind: input.kind,
      resumed: true,
    };
  }

  let paymentId = pending ? String(pending["id"]) : null;
  if (paymentId) {
    // Amount changed under a stale pending attempt: retire it and start again.
    await supabase
      .from("payments")
      .update({ status: "cancelled", failure_reason: "amount_superseded" })
      .eq("id", paymentId)
      .eq("agency_id", quotation.agency_id)
      .eq("status", "pending");
    paymentId = null;
  }

  const { data: created, error: insertError } = await supabase
    .from("payments")
    .insert({
      agency_id: quotation.agency_id,
      lead_id: quotation.lead_id ?? null,
      quotation_id: quotation.id,
      booking_id: booking.booking.id,
      kind: input.kind,
      status: "pending",
      provider: "stripe",
      currency: quotation.currency ?? "MYR",
      amount_myr: amountMyr,
      amount_minor: amountMinor,
      metadata: { quotation_number: quotation.quotation_number ?? null },
    })
    .select("id")
    .maybeSingle();

  if (insertError || !created) return { ok: false, reason: "booking_unavailable" };
  paymentId = String((created as { id: string }).id);

  const { createPaymentCheckoutSession } = await import("@/lib/payments/payment-checkout.server");
  const session = await createPaymentCheckoutSession({
    scope: {
      agencyId: quotation.agency_id,
      quotationId: quotation.id,
      bookingId: booking.booking.id,
      paymentId,
      kind: input.kind,
      leadId: quotation.lead_id ?? null,
    },
    amountMyr,
    quotationNumber: quotation.quotation_number ?? null,
    publicToken: quotation.public_token ?? input.token,
    customerEmail: input.customerEmail ?? null,
  });

  if (session.status !== "ready") {
    await supabase
      .from("payments")
      .update({ status: "cancelled", failure_reason: session.reason })
      .eq("id", paymentId)
      .eq("agency_id", quotation.agency_id)
      .eq("status", "pending");
    return { ok: false, reason: "provider_unavailable" };
  }

  await supabase
    .from("payments")
    .update({ checkout_session_id: session.sessionId, checkout_url: session.url })
    .eq("id", paymentId)
    .eq("agency_id", quotation.agency_id);

  await logConversionEvent(supabase, {
    agencyId: quotation.agency_id,
    stage: "payment_checkout_created",
    actor: "customer",
    leadId: quotation.lead_id ?? null,
    quotationId: quotation.id,
    bookingId: booking.booking.id,
    meta: { provider: "stripe", kind: input.kind, amount_myr: amountMyr, payment_id: paymentId },
  });

  return { ok: true, url: session.url, paymentId, amountMyr, kind: input.kind, resumed: false };
}

/* ------------------------------ webhook side ------------------------------ */

export type ApplyPaymentEventResult =
  | { applied: true; paymentId: string; status: string; kind: PaymentKind }
  | {
      applied: false;
      reason: "duplicate" | "payment_not_found" | "already_final" | "amount_mismatch";
    };

/**
 * Apply one signature-verified Stripe event. The `payment_events` unique index
 * on (provider, provider_event_id) is the idempotency boundary: a duplicate
 * delivery short-circuits before any commercial state is touched.
 */
export async function applyStripePaymentEvent(
  supabase: Db,
  event: ResolvedPaymentEvent,
): Promise<ApplyPaymentEventResult> {
  const { error: ledgerError } = await supabase.from("payment_events").insert({
    provider: "stripe",
    provider_event_id: event.eventId,
    event_type: event.eventType,
    agency_id: event.agencyId,
    payment_id: event.paymentId,
    payload: {
      outcome: event.outcome,
      kind: event.kind,
      payment_ref: event.paymentRef,
      amount_minor: event.amountMinor,
    },
  });
  if (ledgerError) return { applied: false, reason: "duplicate" };

  const { data: payment } = await supabase
    .from("payments")
    .select("id, agency_id, quotation_id, booking_id, lead_id, kind, status, amount_minor, amount_myr")
    .eq("id", event.paymentId)
    .eq("agency_id", event.agencyId)
    .eq("quotation_id", event.quotationId)
    .eq("booking_id", event.bookingId)
    .maybeSingle();

  if (!payment) return { applied: false, reason: "payment_not_found" };
  if (payment.status !== "pending") return { applied: false, reason: "already_final" };

  // The charged amount must match the server-derived amount exactly.
  if (
    event.outcome === "succeeded" &&
    event.amountMinor !== null &&
    Number(payment.amount_minor) !== event.amountMinor
  ) {
    await supabase
      .from("payments")
      .update({ status: "failed", failed_at: new Date().toISOString(), failure_reason: "amount_mismatch" })
      .eq("id", payment.id)
      .eq("agency_id", event.agencyId)
      .eq("status", "pending");
    return { applied: false, reason: "amount_mismatch" };
  }

  const status = paymentStatusForOutcome(event.outcome);
  const now = new Date().toISOString();
  const { data: updatedRows } = await supabase
    .from("payments")
    .update({
      status,
      ...(status === "succeeded" ? { paid_at: now } : {}),
      ...(status === "failed" ? { failed_at: now, failure_reason: event.failureReason } : {}),
      ...(status === "expired" ? { expired_at: now, failure_reason: event.failureReason } : {}),
      ...(event.paymentRef ? { payment_intent_id: event.paymentRef } : {}),
    })
    .eq("id", payment.id)
    .eq("agency_id", event.agencyId)
    .eq("status", "pending")
    .select("id");

  if (!((updatedRows ?? []) as unknown[]).length) return { applied: false, reason: "duplicate" };

  if (status === "succeeded") {
    if (payment.kind === "full") {
      await markFullPaymentPaid(supabase, {
        agencyId: event.agencyId,
        bookingId: event.bookingId,
        quotationId: event.quotationId,
        paymentRef: event.paymentRef ?? payment.id,
        amountMyr: event.amountMyr ?? Number(payment.amount_myr),
      });
    } else {
      await markDepositPaid(supabase, {
        agencyId: event.agencyId,
        bookingId: event.bookingId,
        quotationId: event.quotationId,
        paymentRef: event.paymentRef ?? payment.id,
        amountMyr: event.amountMyr ?? Number(payment.amount_myr),
      });
    }
  } else {
    await supabase.from("activity_log").insert({
      agency_id: event.agencyId,
      actor: "system",
      action: status === "expired" ? "Payment checkout expired" : "Payment failed",
      entity: "payment",
      entity_id: payment.id,
      meta: {
        kind: payment.kind,
        quotation_id: event.quotationId,
        booking_id: event.bookingId,
        reason: event.failureReason,
      },
    });
    await logConversionEvent(supabase, {
      agencyId: event.agencyId,
      stage: status === "expired" ? "payment_expired" : "payment_failed",
      actor: "customer",
      leadId: payment.lead_id ?? null,
      quotationId: event.quotationId,
      bookingId: event.bookingId,
      meta: { provider: "stripe", kind: payment.kind, reason: event.failureReason },
    });
  }

  await supabase
    .from("payment_events")
    .update({ outcome: status })
    .eq("provider", "stripe")
    .eq("provider_event_id", event.eventId);

  return { applied: true, paymentId: String(payment.id), status, kind: payment.kind as PaymentKind };
}

export type FullPaymentResult =
  | { applied: true; bookingId: string; leadId: string | null }
  | { applied: false; reason: "already_paid" | "not_found" };

/**
 * Full payment confirmed. Moves the booking to `booked` with no outstanding
 * balance and the quotation to `booked`. Conditional on the booking not being
 * booked already, so replays are no-ops.
 */
export async function markFullPaymentPaid(
  supabase: Db,
  input: {
    agencyId: string;
    bookingId: string;
    quotationId: string;
    paymentRef: string;
    amountMyr?: number | null;
  },
): Promise<FullPaymentResult> {
  const { data: updatedRows } = await supabase
    .from("bookings")
    .update({ deposit_paid: true, status: "booked", balance_myr: 0 })
    .eq("id", input.bookingId)
    .eq("agency_id", input.agencyId)
    .eq("quotation_id", input.quotationId)
    .neq("status", "booked")
    .select("id, lead_id");

  const row = ((updatedRows ?? []) as Array<{ id: string; lead_id?: string | null }>)[0];
  if (!row) return { applied: false, reason: "already_paid" };

  await supabase
    .from("quotations")
    .update({ status: "booked" })
    .eq("id", input.quotationId)
    .eq("agency_id", input.agencyId)
    .in("status", ["accepted", "deposit_pending", "deposit_paid"]);

  await logConversionEvent(supabase, {
    agencyId: input.agencyId,
    stage: "booking_confirmed",
    actor: "customer",
    leadId: row.lead_id ?? null,
    quotationId: input.quotationId,
    bookingId: row.id,
    meta: {
      provider: "stripe",
      payment_kind: "full",
      payment_ref: input.paymentRef,
      amount_myr: input.amountMyr ?? null,
    },
  });

  await supabase.from("activity_log").insert({
    agency_id: input.agencyId,
    actor: "system",
    action: "Full payment confirmed by Stripe",
    entity: "booking",
    entity_id: row.id,
    meta: { payment_ref: input.paymentRef, quotation_id: input.quotationId },
  });

  return { applied: true, bookingId: row.id, leadId: row.lead_id ?? null };
}
