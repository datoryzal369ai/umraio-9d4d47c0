import { describe, expect, it } from "vitest";

import {
  DEPOSIT_CHECKOUT_KIND,
  depositCheckoutMetadata,
  depositCheckoutReply,
  depositMinorUnits,
  resolveDepositPayment,
} from "@/lib/bookings/deposit.core";
import {
  ensureBookingForAcceptedQuotation,
  markDepositPaid,
} from "@/lib/bookings/booking.server";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

/** Minimal in-memory Supabase double: filter chains + insert/update/select. */
function makeDb(tables: Record<string, Row[]>) {
  const calls: Array<{ table: string; op: string; payload?: Row }> = [];

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => r[col] !== val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      order: () => api,
      limit: () => run(),
      maybeSingle: () => {
        const res = run();
        return Promise.resolve({ data: (res as any).data?.[0] ?? null, error: null });
      },
      single: () => api.maybeSingle(),
      insert: (data: Row) => {
        op = "insert";
        payload = data;
        return api;
      },
      update: (data: Row) => {
        op = "update";
        payload = data;
        return api;
      },
      then: (res: any, rej: any) => run().then(res, rej),
    };

    function matched() {
      return (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }

    function run() {
      calls.push({ table, op, ...(payload ? { payload } : {}) });
      if (op === "insert") {
        const row = { id: payload!["id"] ?? `${table}-${(tables[table] ?? []).length + 1}`, ...payload };
        tables[table] = [...(tables[table] ?? []), row];
        return Promise.resolve({ data: [row], error: null });
      }
      if (op === "update") {
        const rows = matched();
        for (const r of rows) Object.assign(r, payload);
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: matched(), error: null });
    }

    return api;
  }

  return { db: { from: (t: string) => query(t) } as any, tables, calls };
}

const QUOTATION = {
  id: "q1",
  agency_id: "A",
  lead_id: "lead-1",
  package_id: "pkg-1",
  status: "accepted",
  quotation_number: "Q-2026-0002",
  total: 15000,
  deposit_amount: 1500,
  balance_amount: 13500,
  number_of_pilgrims: 3,
  public_token: "tok",
};

describe("Y-1 accepted quotation → booking", () => {
  it("creates exactly one booking and moves the quotation to deposit_pending", async () => {
    const { db, tables } = makeDb({ quotations: [{ ...QUOTATION }], bookings: [], conversion_events: [] });
    const res = await ensureBookingForAcceptedQuotation(db, { agencyId: "A", quotationId: "q1" });

    expect(res.ok && res.created).toBe(true);
    expect(tables["bookings"]).toHaveLength(1);
    expect(tables["bookings"]![0]!["status"]).toBe("deposit_pending");
    expect(tables["bookings"]![0]!["deposit_paid"]).toBe(false);
    expect(tables["quotations"]![0]!["status"]).toBe("deposit_pending");
    expect(
      tables["conversion_events"]!.filter((e) => e["stage"] === "booking_created"),
    ).toHaveLength(1);
  });

  it("replayed acceptance does not create a second booking or event", async () => {
    const { db, tables } = makeDb({ quotations: [{ ...QUOTATION }], bookings: [], conversion_events: [] });
    await ensureBookingForAcceptedQuotation(db, { agencyId: "A", quotationId: "q1" });
    const second = await ensureBookingForAcceptedQuotation(db, { agencyId: "A", quotationId: "q1" });

    expect(second.ok && second.created).toBe(false);
    expect(tables["bookings"]).toHaveLength(1);
    expect(
      tables["conversion_events"]!.filter((e) => e["stage"] === "booking_created"),
    ).toHaveLength(1);
  });

  it("acceptance never marks the deposit as paid", async () => {
    const { db, tables } = makeDb({ quotations: [{ ...QUOTATION }], bookings: [], conversion_events: [] });
    await ensureBookingForAcceptedQuotation(db, { agencyId: "A", quotationId: "q1" });
    expect(tables["bookings"]![0]!["deposit_paid"]).toBe(false);
    expect(tables["quotations"]![0]!["status"]).not.toBe("deposit_paid");
    expect(tables["conversion_events"]!.some((e) => e["stage"] === "deposit_paid")).toBe(false);
  });

  it("refuses a quotation belonging to another agency", async () => {
    const { db, tables } = makeDb({ quotations: [{ ...QUOTATION }], bookings: [], conversion_events: [] });
    const res = await ensureBookingForAcceptedQuotation(db, { agencyId: "B", quotationId: "q1" });
    expect(res).toEqual({ ok: false, reason: "quotation_not_found" });
    expect(tables["bookings"]).toHaveLength(0);
  });
});

describe("Y-2 Stripe deposit checkout payload", () => {
  it("links the session to agency + lead + quotation + booking", () => {
    const meta = depositCheckoutMetadata({
      agencyId: "A",
      quotationId: "q1",
      bookingId: "b1",
      leadId: "lead-1",
    });
    expect(meta).toEqual({
      kind: DEPOSIT_CHECKOUT_KIND,
      agency_id: "A",
      quotation_id: "q1",
      booking_id: "b1",
      lead_id: "lead-1",
    });
    expect(depositMinorUnits(1500)).toBe(150_000);
  });

  it("never claims the payment succeeded", () => {
    const reply = depositCheckoutReply({
      quotationNumber: "Q-2026-0002",
      depositMyr: 1500,
      url: "https://checkout.stripe.com/c/pay/x",
    });
    expect(reply).toContain("*DEPOSIT*");
    expect(reply).toContain("https://checkout.stripe.com/c/pay/x");
    expect(reply).not.toMatch(/telah dibayar|pembayaran berjaya diterima\./);
    expect(reply).toMatch(/hanya disahkan selepas pembayaran/i);
  });

  it("ignores non-deposit, unpaid and cancelled sessions", () => {
    const base = {
      mode: "payment",
      payment_status: "paid",
      metadata: { kind: DEPOSIT_CHECKOUT_KIND, agency_id: "A", quotation_id: "q1", booking_id: "b1" },
    };
    expect(resolveDepositPayment({ ...base, mode: "subscription" }).ok).toBe(false);
    expect(resolveDepositPayment({ ...base, payment_status: "unpaid" })).toEqual({
      ok: false,
      reason: "not_paid",
    });
    expect(resolveDepositPayment({ ...base, metadata: { kind: "other" } })).toEqual({
      ok: false,
      reason: "not_deposit",
    });
    expect(resolveDepositPayment({ ...base, metadata: { kind: DEPOSIT_CHECKOUT_KIND } })).toEqual({
      ok: false,
      reason: "missing_scope",
    });
  });
});

const PAID_SESSION = {
  id: "cs_1",
  mode: "payment",
  payment_status: "paid",
  amount_total: 150_000,
  currency: "myr",
  payment_intent: "pi_1",
  metadata: {
    kind: DEPOSIT_CHECKOUT_KIND,
    agency_id: "A",
    quotation_id: "q1",
    booking_id: "b1",
    lead_id: "lead-1",
  },
};

function paidDb() {
  return makeDb({
    quotations: [{ ...QUOTATION, status: "deposit_pending" }],
    bookings: [
      {
        id: "b1",
        agency_id: "A",
        lead_id: "lead-1",
        quotation_id: "q1",
        status: "deposit_pending",
        deposit_paid: false,
      },
    ],
    conversion_events: [],
    activity_log: [],
  });
}

describe("Y-2 verified webhook → deposit paid", () => {
  it("marks the correct booking and quotation paid once", async () => {
    const { db, tables } = paidDb();
    const resolved = resolveDepositPayment(PAID_SESSION);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const res = await markDepositPaid(db, {
      agencyId: resolved.agencyId,
      bookingId: resolved.bookingId,
      quotationId: resolved.quotationId,
      paymentRef: resolved.paymentRef,
      amountMyr: resolved.amountMyr,
    });

    expect(res).toEqual({ applied: true, bookingId: "b1", leadId: "lead-1" });
    expect(tables["bookings"]![0]!["deposit_paid"]).toBe(true);
    expect(tables["bookings"]![0]!["status"]).toBe("deposit_paid");
    expect(tables["quotations"]![0]!["status"]).toBe("deposit_paid");
    expect(tables["conversion_events"]!.filter((e) => e["stage"] === "deposit_paid")).toHaveLength(1);
  });

  it("is idempotent for a replayed webhook delivery", async () => {
    const { db, tables } = paidDb();
    const args = {
      agencyId: "A",
      bookingId: "b1",
      quotationId: "q1",
      paymentRef: "pi_1",
      amountMyr: 1500,
    };
    await markDepositPaid(db, args);
    const replay = await markDepositPaid(db, args);

    expect(replay).toEqual({ applied: false, reason: "already_paid" });
    expect(tables["conversion_events"]!.filter((e) => e["stage"] === "deposit_paid")).toHaveLength(1);
    expect(tables["activity_log"]).toHaveLength(1);
  });

  it("cannot mutate another agency's booking", async () => {
    const { db, tables } = paidDb();
    const res = await markDepositPaid(db, {
      agencyId: "B",
      bookingId: "b1",
      quotationId: "q1",
      paymentRef: "pi_evil",
    });
    expect(res.applied).toBe(false);
    expect(tables["bookings"]![0]!["deposit_paid"]).toBe(false);
    expect(tables["conversion_events"]).toHaveLength(0);
  });

  it("a cancelled or failed checkout never marks the deposit paid", async () => {
    const { db, tables } = paidDb();
    const cancelled = resolveDepositPayment({
      ...PAID_SESSION,
      payment_status: "unpaid",
      status: "expired",
    });
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) await markDepositPaid(db, cancelled as never);
    expect(tables["bookings"]![0]!["deposit_paid"]).toBe(false);
  });
});
