import type { SupabaseClient } from "@supabase/supabase-js";

import {
  canTransition,
  computeQuotation,
  formatMyrAmount,
  quotationMessage,
  type DepositPolicy,
  type QuotationStatus,
} from "./pricing.core";
import { resolvePublicSiteUrl } from "./public-url.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export const PUBLIC_SITE_URL = resolvePublicSiteUrl(process.env["PUBLIC_SITE_URL"]);

export function quotationLink(token: string) {
  return `${PUBLIC_SITE_URL}/q/${token}`;
}

import { logConversionEvent } from "../conversion/events";
import { recordBookingStatusTransition, recordLeadStageTransition } from "../conversion/producers";

export { logConversionEvent };

/** Deposit policy is agency-configured, never model-decided. */
export async function loadDepositPolicy(
  supabase: Db,
  agencyId: string,
): Promise<{
  policy: DepositPolicy;
  validityDays: number;
}> {
  const { data } = await supabase
    .from("agency_settings")
    .select("deposit_rule, deposit_fixed_myr, deposit_percent, quotation_validity_days")
    .eq("agency_id", agencyId)
    .maybeSingle();
  return {
    policy: {
      rule: (data?.deposit_rule ?? "none") as DepositPolicy["rule"],
      fixedMyr: data?.deposit_fixed_myr ?? null,
      percent: data?.deposit_percent ?? null,
    },
    validityDays: Number(data?.quotation_validity_days ?? 7) || 7,
  };
}

async function nextQuotationNumber(supabase: Db, agencyId: string, attempt = 0) {
  const { count } = await supabase
    .from("quotations")
    .select("id", { count: "exact", head: true })
    .eq("agency_id", agencyId);
  // `count + 1` can collide under concurrency; the caller retries with a
  // higher attempt offset until the insert succeeds.
  const seq = (count ?? 0) + 1 + attempt;
  const year = new Date().getUTCFullYear();
  return `Q-${year}-${String(seq).padStart(4, "0")}`;
}

function isDuplicateNumber(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "23505" ||
    /duplicate key|already exists|unique constraint/i.test(error.message ?? "")
  );
}

export type CreateQuotationInput = {
  packageId: string;
  pilgrims: number;
  leadId?: string | null;
  conversationId?: string | null;
  travelMonth?: string | null;
  travelDate?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
  /** Only a human may pass a discount. AI callers must leave this undefined. */
  discount?: number;
  createdBy?: string | null;
};

export async function createQuotation(supabase: Db, agencyId: string, input: CreateQuotationInput) {
  const { data: pkg, error: pkgError } = await supabase
    .from("packages")
    .select(
      "id, name, hotel_makkah, hotel_madinah, star_rating, nights, departure_date, airline, price_myr, inclusions, is_active",
    )
    .eq("id", input.packageId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (pkgError) throw new Error(pkgError.message);
  if (!pkg) throw new Error("Package not found for this agency.");
  if (pkg.is_active === false) throw new Error("That package is no longer active.");

  const { policy, validityDays } = await loadDepositPolicy(supabase, agencyId);
  const pricing = computeQuotation({
    unitPrice: Number(pkg.price_myr ?? 0),
    pilgrims: input.pilgrims,
    discount: input.discount ?? 0,
    deposit: policy,
  });

  const validUntil = new Date(Date.now() + validityDays * 24 * 3600_000).toISOString();

  let data: any = null;
  let error: any = null;
  let quotationNumber = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    quotationNumber = await nextQuotationNumber(supabase, agencyId, attempt);
    const result = await supabase
      .from("quotations")
      .insert({
        agency_id: agencyId,
        lead_id: input.leadId ?? null,
        conversation_id: input.conversationId ?? null,
        package_id: pkg.id,
        quotation_number: quotationNumber,
        status: "ready",
        customer_name: input.customerName ?? null,
        customer_phone: input.customerPhone ?? null,
        travel_month: input.travelMonth ?? null,
        travel_date: input.travelDate ?? null,
        number_of_pilgrims: pricing.quantity,
        unit_price: pricing.unitPrice,
        quantity: pricing.quantity,
        subtotal: pricing.subtotal,
        discount: pricing.discount,
        total: pricing.total,
        deposit_rule: pricing.depositRule,
        deposit_amount: pricing.depositAmount,
        balance_amount: pricing.balanceAmount,
        valid_until: validUntil,
        notes: input.notes ?? null,
        created_by: input.createdBy ?? null,
        package_snapshot: {
          name: pkg.name,
          hotel_makkah: pkg.hotel_makkah,
          hotel_madinah: pkg.hotel_madinah,
          star_rating: pkg.star_rating,
          nights: pkg.nights,
          departure_date: pkg.departure_date,
          airline: pkg.airline,
          inclusions: pkg.inclusions ?? [],
          price_myr: pkg.price_myr,
        },
      })
      .select("*")
      .single();
    data = result.data;
    error = result.error;
    if (!error) break;
    if (!isDuplicateNumber(error)) break;
  }
  if (error) throw new Error(error.message);

  await logConversionEvent(supabase, {
    agencyId,
    stage: "quotation_created",
    actor: input.createdBy ? "human" : "ai",
    leadId: input.leadId ?? null,
    quotationId: data.id,
    meta: { total: pricing.total, package: pkg.name },
  });

  if (input.leadId) {
    await supabase
      .from("leads")
      .update({ stage: "proposal", last_contact_at: new Date().toISOString() })
      .eq("id", input.leadId)
      .in("stage", ["new", "contacted", "qualified"]);
    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: input.createdBy ? "human" : "ai",
      action: `Quotation ${quotationNumber} issued (${formatMyrAmount(pricing.total)})`,
      entity: "lead",
      entity_id: input.leadId,
      meta: { quotation_id: data.id, package: pkg.name },
    });
  }

  return data;
}

/** Customer-facing text for a quotation row. */
export function renderQuotationMessage(row: any, agencyName: string) {
  const snap = (row.package_snapshot ?? {}) as Record<string, unknown>;
  return quotationMessage({
    quotationNumber: row.quotation_number,
    agencyName,
    packageName: String(snap["name"] ?? "Umrah package"),
    travelLabel: row.travel_date ?? row.travel_month ?? null,
    validUntil: row.valid_until ? new Date(row.valid_until).toLocaleDateString("en-MY") : null,
    link: quotationLink(row.public_token),
    pricing: {
      unitPrice: Number(row.unit_price ?? 0),
      quantity: Number(row.quantity ?? 1),
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      total: Number(row.total ?? 0),
      depositRule: row.deposit_rule,
      depositAmount: row.deposit_amount === null ? null : Number(row.deposit_amount),
      balanceAmount: row.balance_amount === null ? null : Number(row.balance_amount),
    },
  });
}

const TIMESTAMP_FOR_STATUS: Partial<Record<QuotationStatus, string>> = {
  sent: "sent_at",
  viewed: "viewed_at",
  accepted: "accepted_at",
  rejected: "rejected_at",
  cancelled: "cancelled_at",
};

export async function transitionQuotation(
  supabase: Db,
  agencyId: string,
  quotationId: string,
  to: QuotationStatus,
  opts: { actor?: "ai" | "human" | "customer" | "system"; reason?: string | null } = {},
) {
  const { data: row, error } = await supabase
    .from("quotations")
    .select(
      "id, agency_id, lead_id, status, total, deposit_amount, balance_amount, package_id, number_of_pilgrims",
    )
    .eq("id", quotationId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Quotation not found.");
  const from = row.status as QuotationStatus;
  if (from === to) return row;
  if (!canTransition(from, to)) {
    throw new Error(`Cannot move a quotation from "${from}" to "${to}".`);
  }

  const patch: Record<string, unknown> = { status: to };
  const stamp = TIMESTAMP_FOR_STATUS[to];
  if (stamp) patch[stamp] = new Date().toISOString();

  const { data: updated, error: updateError } = await supabase
    .from("quotations")
    .update(patch)
    .eq("id", quotationId)
    .select("*")
    .single();
  if (updateError) throw new Error(updateError.message);

  await logConversionEvent(supabase, {
    agencyId,
    stage: `quotation_${to}`,
    actor: opts.actor ?? "human",
    leadId: row.lead_id,
    quotationId,
    reason: opts.reason ?? null,
    meta: { from, to },
  });

  // Deposit-ready state creates the booking shell so conversion is measurable.
  if (to === "deposit_paid") {
    const { data: booking } = await supabase
      .from("bookings")
      .insert({
        agency_id: agencyId,
        lead_id: row.lead_id,
        package_id: row.package_id,
        quotation_id: quotationId,
        pax: row.number_of_pilgrims ?? 1,
        amount_myr: row.total ?? 0,
        deposit_amount_myr: row.deposit_amount,
        balance_myr: row.balance_amount,
        deposit_paid: true,
        status: "deposit_paid",
      })
      .select("id")
      .single();
    if (booking) {
      await logConversionEvent(supabase, {
        agencyId,
        stage: "booking_created",
        actor: opts.actor ?? "human",
        leadId: row.lead_id,
        quotationId,
        bookingId: booking.id,
      });
    }
  }

  if (to === "booked" && row.lead_id) {
    // B-2 — lead_won is emitted from the authoritative won transition only,
    // and only when the lead was not already booked (no duplicate wins).
    const { data: leadRow } = await supabase
      .from("leads")
      .select("stage")
      .eq("id", row.lead_id)
      .eq("agency_id", agencyId)
      .maybeSingle();
    await supabase.from("leads").update({ stage: "booked" }).eq("id", row.lead_id);
    await recordLeadStageTransition({
      db: supabase,
      agencyId,
      leadId: row.lead_id,
      from: (leadRow?.stage as string | undefined) ?? null,
      to: "booked",
      actor: opts.actor ?? "human",
      reason: opts.reason ?? null,
    });
  }

  if (to === "booked") {
    // B-2 (booking attribution) — the bookings row is the authoritative booking
    // status source. Confirm it exactly once; the conditional update guarantees
    // idempotency, so a replayed transition emits no duplicate conversion event.
    const { data: confirmed } = await supabase
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("quotation_id", quotationId)
      .eq("agency_id", agencyId)
      .neq("status", "confirmed")
      .select("id, lead_id, status");
    for (const booking of (confirmed ?? []) as Array<Record<string, any>>) {
      await recordBookingStatusTransition({
        db: supabase,
        agencyId,
        bookingId: booking["id"] as string,
        leadId: (booking["lead_id"] as string | null) ?? row.lead_id ?? null,
        quotationId,
        from: from as string,
        to: "confirmed",
        actor: opts.actor ?? "human",
        reason: opts.reason ?? null,
      });
    }
  }

  return updated;
}

/** Public (token) read. Marks the quotation viewed exactly once. */
/** Fields the customer-facing quotation page renders. */
const PUBLIC_SNAPSHOT_KEYS = [
  "name",
  "hotel_makkah",
  "hotel_madinah",
  "nights",
  "star_rating",
  "airline",
  "departure_date",
  "inclusions",
] as const;

function publicSnapshot(raw: unknown): Record<string, any> {
  const snap = (raw ?? {}) as Record<string, any>;
  const out: Record<string, any> = {};
  for (const key of PUBLIC_SNAPSHOT_KEYS) {
    if (snap[key] !== undefined && snap[key] !== null) out[key] = snap[key];
  }
  return out;
}

/** Customer-safe projection — internal identifiers and notes never leave the server. */
export function toPublicQuotation(row: Record<string, any>) {
  return {
    quotation_number: row["quotation_number"],
    status: row["status"],
    currency: row["currency"],
    customer_name: row["customer_name"],
    travel_date: row["travel_date"],
    travel_month: row["travel_month"],
    number_of_pilgrims: row["number_of_pilgrims"],
    unit_price: row["unit_price"],
    quantity: row["quantity"],
    subtotal: row["subtotal"],
    discount: row["discount"],
    total: row["total"],
    deposit_amount: row["deposit_amount"],
    balance_amount: row["balance_amount"],
    package_snapshot: publicSnapshot(row["package_snapshot"]),
    valid_until: row["valid_until"],
  };
}

export async function readQuotationByToken(supabase: Db, token: string) {
  const { data: row } = await supabase
    .from("quotations")
    .select(
      "id, agency_id, lead_id, quotation_number, status, currency, customer_name, travel_date, travel_month, number_of_pilgrims, unit_price, quantity, subtotal, discount, total, deposit_amount, balance_amount, package_snapshot, valid_until",
    )
    .eq("public_token", token)
    .maybeSingle();
  if (!row) return null;

  const expired =
    row.valid_until &&
    new Date(row.valid_until).getTime() < Date.now() &&
    ["ready", "sent", "viewed", "discussing"].includes(row.status);

  if (expired) {
    await supabase.from("quotations").update({ status: "expired" }).eq("id", row.id);
    row.status = "expired";
  } else if (row.status === "sent") {
    await supabase
      .from("quotations")
      .update({ status: "viewed", viewed_at: new Date().toISOString() })
      .eq("id", row.id);
    row.status = "viewed";
    await logConversionEvent(supabase, {
      agencyId: row.agency_id,
      stage: "quotation_viewed",
      actor: "customer",
      leadId: row.lead_id,
      quotationId: row.id,
    });
  }

  const { data: agency } = await supabase
    .from("agencies")
    .select("name, contact_phone, contact_email, logo_url")
    .eq("id", row.agency_id)
    .maybeSingle();

  return { quotation: toPublicQuotation(row), agency };
}


/** Customer decision from the public quotation page. */
export async function respondToQuotationByToken(
  supabase: Db,
  token: string,
  decision: "accepted" | "rejected",
  reason?: string | null,
) {
  const { data: row } = await supabase
    .from("quotations")
    .select("id, agency_id, lead_id, status, quotation_number, total")
    .eq("public_token", token)
    .maybeSingle();
  if (!row) throw new Error("Quotation not found.");
  const from = row.status as QuotationStatus;
  if (!canTransition(from, decision)) {
    throw new Error("This quotation can no longer be updated.");
  }

  const updated = await transitionQuotation(supabase, row.agency_id, row.id, decision, {
    actor: "customer",
    reason: reason ?? null,
  });

  await supabase.from("notifications").insert({
    agency_id: row.agency_id,
    kind: decision === "accepted" ? "quotation_accepted" : "quotation_rejected",
    severity: decision === "accepted" ? "success" : "warning",
    title:
      decision === "accepted"
        ? `Quotation ${row.quotation_number} accepted`
        : `Quotation ${row.quotation_number} declined`,
    body:
      decision === "accepted"
        ? `The customer accepted ${formatMyrAmount(Number(row.total ?? 0))}. Collect the deposit to confirm the booking.`
        : reason || "The customer declined the quotation.",
    entity: "quotation",
    entity_id: row.id,
    meta: {},
  });

  if (decision === "accepted") {
    // Deposit-ready, never auto-charged: a human confirms payment.
    await transitionQuotation(supabase, row.agency_id, row.id, "deposit_pending", {
      actor: "system",
      reason: "Awaiting deposit confirmation",
    });
  }

  return updated;
}
