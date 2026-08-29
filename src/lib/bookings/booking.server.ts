/**
 * UMRAIO® — Y-1 booking lifecycle (server-only helpers).
 *
 * Accepted quotation → booking shell (`deposit_pending`) → verified deposit
 * payment → `deposit_paid`. Every write is tenant-scoped by `agency_id` and
 * idempotent by construction: booking creation looks up the existing row for
 * the quotation first, and the deposit confirmation is a conditional update
 * that touches zero rows on replay.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logConversionEvent } from "@/lib/conversion/events";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type BookingRecord = {
  id: string;
  agency_id?: string | null;
  lead_id?: string | null;
  quotation_id?: string | null;
  status?: string | null;
  deposit_paid?: boolean | null;
  deposit_amount_myr?: number | string | null;
  amount_myr?: number | string | null;
};

export type EnsureBookingResult =
  | { ok: true; created: boolean; booking: BookingRecord; depositMyr: number | null }
  | { ok: false; reason: "quotation_not_found" | "not_accepted" | "insert_failed" };

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Quotation statuses from which a booking shell may be created. */
export const BOOKABLE_QUOTATION_STATUSES = ["accepted", "deposit_pending"] as const;

/**
 * Create (or return) the single booking row for an accepted quotation, and
 * move the quotation to `deposit_pending` when a deposit is owed.
 * Never marks anything as paid.
 */
export async function ensureBookingForAcceptedQuotation(
  supabase: Db,
  scope: { agencyId: string; quotationId: string; actor?: "ai" | "human" | "customer" | "system" },
): Promise<EnsureBookingResult> {
  const { data: quotation } = await supabase
    .from("quotations")
    .select(
      "id, agency_id, lead_id, package_id, status, quotation_number, total, deposit_amount, balance_amount, number_of_pilgrims",
    )
    .eq("id", scope.quotationId)
    .eq("agency_id", scope.agencyId)
    .maybeSingle();

  if (!quotation) return { ok: false, reason: "quotation_not_found" };
  if (!(BOOKABLE_QUOTATION_STATUSES as readonly string[]).includes(String(quotation.status))) {
    return { ok: false, reason: "not_accepted" };
  }

  // Y-2 FIX — the deposit owed is ALWAYS derived on the server. When the
  // quotation row has no deposit yet (legacy rows, or an agency that never
  // configured a deposit rule) it is computed from the agency policy, with the
  // documented platform default as the last resort, then persisted once so the
  // amount charged and the amount shown can never diverge.
  let depositMyr = num(quotation.deposit_amount);
  if (!(depositMyr && depositMyr > 0)) {
    const { data: settings } = await supabase
      .from("agency_settings")
      .select("deposit_rule, deposit_fixed_myr, deposit_percent")
      .eq("agency_id", scope.agencyId)
      .maybeSingle();
    const resolved = resolveDepositMyr({
      totalMyr: num(quotation.total),
      rule: (settings?.deposit_rule ?? null) as string | null,
      fixedMyr: num(settings?.deposit_fixed_myr),
      percent: num(settings?.deposit_percent),
    });
    if (resolved && resolved > 0) {
      depositMyr = resolved;
      const total = num(quotation.total);
      await supabase
        .from("quotations")
        .update({
          deposit_amount: resolved,
          ...(total !== null ? { balance_amount: Math.round((total - resolved) * 100) / 100 } : {}),
        })
        .eq("id", quotation.id)
        .eq("agency_id", scope.agencyId)
        .is("deposit_amount", null);
    }
  }

  // Idempotency: one booking per quotation, scoped to the tenant.
  const { data: existingRows } = await supabase
    .from("bookings")
    .select("id, agency_id, lead_id, quotation_id, status, deposit_paid, deposit_amount_myr, amount_myr")
    .eq("agency_id", scope.agencyId)
    .eq("quotation_id", scope.quotationId)
    .limit(1);
  const existing = ((existingRows ?? []) as BookingRecord[])[0];

  if (existing) {
    await moveQuotationToDepositPending(supabase, scope.agencyId, quotation);
    return { ok: true, created: false, booking: existing, depositMyr };
  }

  const { data: inserted } = await supabase
    .from("bookings")
    .insert({
      agency_id: scope.agencyId,
      lead_id: quotation.lead_id ?? null,
      package_id: quotation.package_id ?? null,
      quotation_id: scope.quotationId,
      pax: quotation.number_of_pilgrims ?? 1,
      amount_myr: quotation.total ?? 0,
      deposit_amount_myr: quotation.deposit_amount ?? null,
      balance_myr: quotation.balance_amount ?? null,
      deposit_paid: false,
      status: "deposit_pending",
    })
    .select("id, agency_id, lead_id, quotation_id, status, deposit_paid, deposit_amount_myr, amount_myr")
    .maybeSingle();

  if (!inserted) {
    // Lost a race (or the insert failed): re-read before giving up.
    const { data: raceRows } = await supabase
      .from("bookings")
      .select("id, agency_id, lead_id, quotation_id, status, deposit_paid, deposit_amount_myr, amount_myr")
      .eq("agency_id", scope.agencyId)
      .eq("quotation_id", scope.quotationId)
      .limit(1);
    const raced = ((raceRows ?? []) as BookingRecord[])[0];
    if (raced) return { ok: true, created: false, booking: raced, depositMyr };
    return { ok: false, reason: "insert_failed" };
  }

  await logConversionEvent(supabase, {
    agencyId: scope.agencyId,
    stage: "booking_created",
    actor: scope.actor ?? "ai",
    leadId: quotation.lead_id ?? null,
    quotationId: scope.quotationId,
    bookingId: (inserted as BookingRecord).id,
    meta: { source: "quotation_accepted", deposit_required: depositMyr !== null },
  });

  await moveQuotationToDepositPending(supabase, scope.agencyId, quotation);

  return { ok: true, created: true, booking: inserted as BookingRecord, depositMyr };
}

async function moveQuotationToDepositPending(
  supabase: Db,
  agencyId: string,
  quotation: { id: string; status?: string | null },
) {
  if (quotation.status !== "accepted") return;
  await supabase
    .from("quotations")
    .update({ status: "deposit_pending" })
    .eq("id", quotation.id)
    .eq("agency_id", agencyId)
    .eq("status", "accepted");
}

export type DepositPaidResult =
  | { applied: true; bookingId: string; leadId: string | null }
  | { applied: false; reason: "already_paid" | "not_found" };

/**
 * Mark a deposit as paid. Called ONLY from the signature-verified Stripe
 * webhook. The conditional update (`deposit_paid = false`, matching tenant and
 * quotation) makes replays and cross-tenant attempts no-ops.
 */
export async function markDepositPaid(
  supabase: Db,
  input: {
    agencyId: string;
    bookingId: string;
    quotationId: string;
    paymentRef: string;
    amountMyr?: number | null;
  },
): Promise<DepositPaidResult> {
  const { data: updatedRows } = await supabase
    .from("bookings")
    .update({ deposit_paid: true, status: "deposit_paid" })
    .eq("id", input.bookingId)
    .eq("agency_id", input.agencyId)
    .eq("quotation_id", input.quotationId)
    .eq("deposit_paid", false)
    .select("id, lead_id");

  const row = ((updatedRows ?? []) as Array<{ id: string; lead_id?: string | null }>)[0];
  if (!row) return { applied: false, reason: "already_paid" };

  await supabase
    .from("quotations")
    .update({ status: "deposit_paid" })
    .eq("id", input.quotationId)
    .eq("agency_id", input.agencyId)
    .in("status", ["accepted", "deposit_pending"]);

  await logConversionEvent(supabase, {
    agencyId: input.agencyId,
    stage: "deposit_paid",
    actor: "customer",
    leadId: row.lead_id ?? null,
    quotationId: input.quotationId,
    bookingId: row.id,
    meta: {
      provider: "stripe",
      payment_ref: input.paymentRef,
      amount_myr: input.amountMyr ?? null,
    },
  });

  await supabase.from("activity_log").insert({
    agency_id: input.agencyId,
    actor: "system",
    action: "Deposit payment confirmed by Stripe",
    entity: "booking",
    entity_id: row.id,
    meta: { payment_ref: input.paymentRef, quotation_id: input.quotationId },
  });

  return { applied: true, bookingId: row.id, leadId: row.lead_id ?? null };
}
