/**
 * UMRAIO® — Stripe commercial payment closure.
 *
 * Covers the payment contract end to end at the logic layer: server-derived
 * amounts, complete attribution, verified-webhook authority, idempotency,
 * failure/expiry, and cross-tenant isolation.
 */
import { describe, expect, it } from "vitest";

import {
  PAYMENT_CHECKOUT_KIND,
  hasCompleteAttribution,
  isPayableQuotationStatus,
  paymentCheckoutMetadata,
  paymentMinorUnits,
  resolvePayableAmountMyr,
  resolveStripePaymentEvent,
} from "@/lib/payments/payment.core";
import { applyStripePaymentEvent } from "@/lib/payments/payment.server";
import { verifyStripeSignature } from "@/lib/stripe.server";
import { createHmac } from "node:crypto";

const AGENCY = "11111111-1111-1111-1111-111111111111";
const OTHER_AGENCY = "99999999-9999-9999-9999-999999999999";
const QUOTATION = "22222222-2222-2222-2222-222222222222";
const BOOKING = "33333333-3333-3333-3333-333333333333";
const PAYMENT = "44444444-4444-4444-4444-444444444444";

/* ------------------------------ fake database ----------------------------- */

type Row = Record<string, unknown>;

function makeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {
    payments: [],
    payment_events: [],
    bookings: [],
    quotations: [],
    activity_log: [],
    conversion_events: [],
    ...seed,
  };

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let pending: Row[] | null = null;
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row = {};

    const match = () => tables[table]!.filter((r) => filters.every((f) => f(r)));

    const api: Record<string, unknown> = {
      select: () => api,
      limit: () => api,
      order: () => api,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), api),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), api),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), api),
      insert: (values: Row) => {
        mode = "insert";
        // Idempotency boundary: unique (provider, provider_event_id).
        if (
          table === "payment_events" &&
          tables[table]!.some((r) => r["provider_event_id"] === values["provider_event_id"])
        ) {
          pending = null;
          (api as { __error?: unknown }).__error = { code: "23505", message: "duplicate key" };
        } else {
          const row = { id: `${table}-${tables[table]!.length + 1}`, ...values };
          tables[table]!.push(row);
          pending = [row];
        }
        return api;
      },
      update: (values: Row) => {
        mode = "update";
        patch = values;
        return api;
      },
      maybeSingle: async () => {
        const err = (api as { __error?: unknown }).__error;
        if (err) return { data: null, error: err };
        const rows = mode === "insert" ? (pending ?? []) : match();
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        const err = (api as { __error?: unknown }).__error;
        if (err) return resolve({ data: null, error: err });
        if (mode === "update") {
          const rows = match();
          rows.forEach((r) => Object.assign(r, patch));
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: mode === "insert" ? (pending ?? []) : match(), error: null });
      },
    };
    return api;
  }

  return { client: { from: (t: string) => query(t) } as never, tables };
}

function pendingPayment(overrides: Row = {}): Row {
  return {
    id: PAYMENT,
    agency_id: AGENCY,
    lead_id: null,
    quotation_id: QUOTATION,
    booking_id: BOOKING,
    kind: "deposit",
    status: "pending",
    amount_minor: 588000,
    amount_myr: 5880,
    ...overrides,
  };
}

function session(overrides: Row = {}, metaOverrides: Row = {}): Row {
  return {
    id: "cs_test_1",
    payment_status: "paid",
    payment_intent: "pi_test_1",
    amount_total: 588000,
    metadata: {
      ...paymentCheckoutMetadata({
        agencyId: AGENCY,
        quotationId: QUOTATION,
        bookingId: BOOKING,
        paymentId: PAYMENT,
        kind: "deposit",
      }),
      ...metaOverrides,
    },
    ...overrides,
  };
}

const envelope = (type: string, object: Row, id = "evt_1") => ({ id, type, data: { object } });

/* ---------------------------------- tests --------------------------------- */

describe("commercial payment amounts (server-derived)", () => {
  it("uses the authoritative deposit amount for a deposit payment", () => {
    expect(resolvePayableAmountMyr({ kind: "deposit", totalMyr: 29400, depositMyr: 5880 })).toBe(5880);
  });

  it("uses the quotation total for a full payment", () => {
    expect(resolvePayableAmountMyr({ kind: "full", totalMyr: 29400, depositMyr: 5880 })).toBe(29400);
  });

  it("never lets a deposit exceed the total", () => {
    expect(resolvePayableAmountMyr({ kind: "deposit", totalMyr: 1000, depositMyr: 5000 })).toBe(1000);
  });

  it("refuses a quotation without a payable total", () => {
    expect(resolvePayableAmountMyr({ kind: "full", totalMyr: 0 })).toBeNull();
    expect(resolvePayableAmountMyr({ kind: "deposit", totalMyr: 100, depositMyr: 0 })).toBeNull();
  });

  it("converts ringgit to sen for Stripe", () => {
    expect(paymentMinorUnits(5880.5)).toBe(588050);
  });

  it("only allows payment from a commercially valid quotation state", () => {
    expect(isPayableQuotationStatus("accepted")).toBe(true);
    expect(isPayableQuotationStatus("deposit_pending")).toBe(true);
    expect(isPayableQuotationStatus("sent")).toBe(false);
    expect(isPayableQuotationStatus("expired")).toBe(false);
  });
});

describe("attribution", () => {
  it("carries tenant, quotation, booking, payment and kind on every checkout", () => {
    const meta = paymentCheckoutMetadata({
      agencyId: AGENCY,
      quotationId: QUOTATION,
      bookingId: BOOKING,
      paymentId: PAYMENT,
      kind: "full",
      leadId: "lead-1",
    });
    expect(meta).toMatchObject({
      kind: PAYMENT_CHECKOUT_KIND,
      payment_kind: "full",
      payment_id: PAYMENT,
      agency_id: AGENCY,
      quotation_id: QUOTATION,
      booking_id: BOOKING,
      lead_id: "lead-1",
    });
    expect(hasCompleteAttribution(meta)).toBe(true);
  });

  it("rejects a partially attributed (orphan) payment", () => {
    expect(hasCompleteAttribution({ kind: PAYMENT_CHECKOUT_KIND, payment_kind: "deposit" })).toBe(false);
    expect(hasCompleteAttribution({})).toBe(false);
  });
});

describe("webhook signature authority", () => {
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const now = 1_800_000_000;
  const sign = (ts: number) =>
    createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");

  it("accepts a correctly signed payload", () => {
    const header = `t=${now},v1=${sign(now)}`;
    expect(verifyStripeSignature(payload, header, secret, now).valid).toBe(true);
  });

  it("rejects an invalid signature", () => {
    expect(verifyStripeSignature(payload, `t=${now},v1=deadbeef`, secret, now).valid).toBe(false);
    expect(verifyStripeSignature(payload, null, secret, now).valid).toBe(false);
  });
});

describe("webhook resolution", () => {
  it("ignores events that are not UMRAIO commercial payments", () => {
    expect(resolveStripePaymentEvent(envelope("checkout.session.completed", { metadata: {} }) as never)).toEqual({
      ok: false,
      reason: "not_umraio_payment",
    });
    expect(resolveStripePaymentEvent(envelope("invoice.paid", session()) as never)).toEqual({
      ok: false,
      reason: "unhandled_event",
    });
  });

  it("refuses a completed checkout that was not actually paid (browser success)", () => {
    const result = resolveStripePaymentEvent(
      envelope("checkout.session.completed", session({ payment_status: "unpaid" })) as never,
    );
    expect(result).toEqual({ ok: false, reason: "not_paid" });
  });

  it("maps expiry and failure to the right outcome", () => {
    const expired = resolveStripePaymentEvent(
      envelope("checkout.session.expired", session({ payment_status: "unpaid" })) as never,
    );
    expect(expired.ok && expired.outcome).toBe("expired");

    const failed = resolveStripePaymentEvent(
      envelope("payment_intent.payment_failed", {
        id: "pi_test_1",
        amount: 588000,
        last_payment_error: { code: "card_declined" },
        metadata: session()["metadata"],
      }) as never,
    );
    expect(failed.ok && failed.outcome).toBe("failed");
    expect(failed.ok && failed.failureReason).toBe("card_declined");
  });
});

describe("ledger application", () => {
  const resolved = () => {
    const r = resolveStripePaymentEvent(envelope("checkout.session.completed", session()) as never);
    if (!r.ok) throw new Error("expected resolvable event");
    return r;
  };

  it("marks a deposit payment succeeded and the booking deposit-paid", async () => {
    const db = makeDb({
      payments: [pendingPayment()],
      bookings: [{ id: BOOKING, agency_id: AGENCY, quotation_id: QUOTATION, deposit_paid: false, status: "pending" }],
    });
    const outcome = await applyStripePaymentEvent(db.client, resolved());
    expect(outcome).toMatchObject({ applied: true, status: "succeeded", kind: "deposit" });
    expect(db.tables["payments"]![0]!["status"]).toBe("succeeded");
    expect(db.tables["bookings"]![0]!["deposit_paid"]).toBe(true);
  });

  it("is idempotent — a duplicate delivery changes nothing", async () => {
    const db = makeDb({
      payments: [pendingPayment()],
      bookings: [{ id: BOOKING, agency_id: AGENCY, quotation_id: QUOTATION, deposit_paid: false, status: "pending" }],
    });
    await applyStripePaymentEvent(db.client, resolved());
    const second = await applyStripePaymentEvent(db.client, resolved());
    expect(second).toEqual({ applied: false, reason: "duplicate" });
    expect(db.tables["payment_events"]!.length).toBe(1);
  });

  it("marks a full payment as booked with no balance", async () => {
    const db = makeDb({
      payments: [pendingPayment({ kind: "full", amount_minor: 2940000, amount_myr: 29400 })],
      bookings: [{ id: BOOKING, agency_id: AGENCY, quotation_id: QUOTATION, deposit_paid: false, status: "pending" }],
      quotations: [{ id: QUOTATION, agency_id: AGENCY, status: "accepted" }],
    });
    const full = resolveStripePaymentEvent(
      envelope(
        "checkout.session.completed",
        session({ amount_total: 2940000 }, { payment_kind: "full" }),
      ) as never,
    );
    expect(full.ok).toBe(true);
    const outcome = await applyStripePaymentEvent(db.client, full as never);
    expect(outcome).toMatchObject({ applied: true, status: "succeeded", kind: "full" });
    expect(db.tables["bookings"]![0]).toMatchObject({ status: "booked", balance_myr: 0 });
    expect(db.tables["quotations"]![0]!["status"]).toBe("booked");
  });

  it("never applies an event to another tenant's payment", async () => {
    const db = makeDb({ payments: [pendingPayment({ agency_id: OTHER_AGENCY })] });
    const outcome = await applyStripePaymentEvent(db.client, resolved());
    expect(outcome).toEqual({ applied: false, reason: "payment_not_found" });
    expect(db.tables["payments"]![0]!["status"]).toBe("pending");
  });

  it("refuses a charge whose amount differs from the server-derived amount", async () => {
    const db = makeDb({ payments: [pendingPayment({ amount_minor: 100 })] });
    const outcome = await applyStripePaymentEvent(db.client, resolved());
    expect(outcome).toEqual({ applied: false, reason: "amount_mismatch" });
    expect(db.tables["payments"]![0]!["status"]).toBe("failed");
  });

  it("records an expired checkout without touching the booking", async () => {
    const db = makeDb({
      payments: [pendingPayment()],
      bookings: [{ id: BOOKING, agency_id: AGENCY, quotation_id: QUOTATION, deposit_paid: false, status: "pending" }],
    });
    const expired = resolveStripePaymentEvent(
      envelope("checkout.session.expired", session({ payment_status: "unpaid" }), "evt_exp") as never,
    );
    const outcome = await applyStripePaymentEvent(db.client, expired as never);
    expect(outcome).toMatchObject({ applied: true, status: "expired" });
    expect(db.tables["bookings"]![0]!["deposit_paid"]).toBe(false);
    expect(db.tables["activity_log"]!.length).toBe(1);
  });

  it("records a failed payment without confirming the booking", async () => {
    const db = makeDb({
      payments: [pendingPayment()],
      bookings: [{ id: BOOKING, agency_id: AGENCY, quotation_id: QUOTATION, deposit_paid: false, status: "pending" }],
    });
    const failed = resolveStripePaymentEvent(
      envelope(
        "payment_intent.payment_failed",
        { id: "pi_test_1", amount: 588000, last_payment_error: { code: "card_declined" }, metadata: session()["metadata"] },
        "evt_fail",
      ) as never,
    );
    const outcome = await applyStripePaymentEvent(db.client, failed as never);
    expect(outcome).toMatchObject({ applied: true, status: "failed" });
    expect(db.tables["payments"]![0]!["failure_reason"]).toBe("card_declined");
    expect(db.tables["bookings"]![0]!["deposit_paid"]).toBe(false);
  });

  it("does not reopen a payment that already reached a final state", async () => {
    const db = makeDb({ payments: [pendingPayment({ status: "expired" })] });
    const outcome = await applyStripePaymentEvent(db.client, resolved());
    expect(outcome).toEqual({ applied: false, reason: "already_final" });
  });
});
