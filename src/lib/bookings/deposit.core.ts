/**
 * UMRAIO® — Y-1 / Y-2 deposit lifecycle, pure logic.
 *
 * No I/O, no env reads. Shared by the booking server helper, the Stripe
 * deposit checkout and the webhook, so the same rules are testable in
 * isolation. Nothing here ever decides that money arrived — only Stripe's
 * signature-verified event does that.
 */

export const DEPOSIT_CHECKOUT_KIND = "umraio_deposit";

export type DepositCheckoutScope = {
  agencyId: string;
  quotationId: string;
  bookingId: string;
  leadId?: string | null;
};

/** Metadata written on both the Checkout Session and the PaymentIntent. */
export function depositCheckoutMetadata(scope: DepositCheckoutScope): Record<string, string> {
  return {
    kind: DEPOSIT_CHECKOUT_KIND,
    agency_id: scope.agencyId,
    quotation_id: scope.quotationId,
    booking_id: scope.bookingId,
    ...(scope.leadId ? { lead_id: scope.leadId } : {}),
  };
}

/** Stripe expects the smallest currency unit (MYR sen). */
export function depositMinorUnits(amountMyr: number): number {
  return Math.round(amountMyr * 100);
}

export type DepositSession = {
  id?: string | null;
  mode?: string | null;
  payment_status?: string | null;
  status?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  payment_intent?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type DepositPaymentResolution =
  | {
      ok: true;
      agencyId: string;
      quotationId: string;
      bookingId: string;
      leadId: string | null;
      paymentRef: string;
      amountMyr: number | null;
    }
  | { ok: false; reason: "not_deposit" | "not_paid" | "missing_scope" };

/**
 * Read a Stripe Checkout Session and decide whether it is a verified UMRAIO
 * deposit payment. Only `payment` mode + `paid` counts; anything cancelled,
 * unpaid or of another kind resolves to a refusal.
 */
export function resolveDepositPayment(session: DepositSession): DepositPaymentResolution {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  if (session.mode !== "payment" || meta["kind"] !== DEPOSIT_CHECKOUT_KIND) {
    return { ok: false, reason: "not_deposit" };
  }
  if (session.payment_status !== "paid") return { ok: false, reason: "not_paid" };

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const agencyId = str(meta["agency_id"]);
  const quotationId = str(meta["quotation_id"]);
  const bookingId = str(meta["booking_id"]);
  if (!agencyId || !quotationId || !bookingId) return { ok: false, reason: "missing_scope" };

  const paymentRef =
    str(session.payment_intent) ?? str(session.id) ?? `${bookingId}:${quotationId}`;
  const amount =
    typeof session.amount_total === "number" ? Math.round(session.amount_total) / 100 : null;

  return {
    ok: true,
    agencyId,
    quotationId,
    bookingId,
    leadId: str(meta["lead_id"]),
    paymentRef,
    amountMyr: amount,
  };
}

const money = (v: number) =>
  `RM${v.toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * Deterministic, truthful deposit instruction. It never claims the deposit is
 * paid — it only states the amount due and the payment link.
 */
export function depositCheckoutReply(facts: {
  quotationNumber?: string | null;
  depositMyr?: number | null;
  url: string;
}): string {
  const lines: string[] = ["*DEPOSIT*", ""];
  lines.push(
    facts.quotationNumber
      ? `Untuk mengesahkan tempahan bagi quotation *${facts.quotationNumber}*, deposit perlu dijelaskan.`
      : "Untuk mengesahkan tempahan, deposit perlu dijelaskan.",
  );
  if (typeof facts.depositMyr === "number" && Number.isFinite(facts.depositMyr)) {
    lines.push("", `*Deposit:* ${money(facts.depositMyr)}`);
  }
  lines.push("", `Pautan pembayaran: ${facts.url}`);
  lines.push(
    "",
    "Tempahan hanya disahkan selepas pembayaran berjaya diterima dan disahkan oleh sistem pembayaran.",
  );
  return lines.join("\n");
}
