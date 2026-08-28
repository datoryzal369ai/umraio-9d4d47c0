/**
 * UMRAIO® — Y-2 Stripe deposit checkout (server-only).
 *
 * Reuses the existing `stripe.server` REST helper — no second payment system,
 * no SDK, no client-side secret. The amount comes from the quotation row on
 * the server; nothing about price or currency is ever accepted from a client
 * or from the customer's chat message. Reaching checkout grants nothing:
 * `deposit_paid` is written only by the signature-verified webhook.
 */
import {
  DEPOSIT_CHECKOUT_KIND,
  depositCheckoutMetadata,
  depositMinorUnits,
  type DepositCheckoutScope,
} from "@/lib/bookings/deposit.core";

export type DepositCheckoutResult =
  | { status: "ready"; url: string; sessionId: string | null }
  | { status: "unavailable"; reason: string };

export async function createDepositCheckoutSession(input: {
  scope: DepositCheckoutScope;
  depositMyr: number;
  quotationNumber?: string | null;
  publicToken?: string | null;
  customerEmail?: string | null;
}): Promise<DepositCheckoutResult> {
  const { hasStripeSecretKey, stripeFetch } = await import("@/lib/stripe.server");
  if (!hasStripeSecretKey()) return { status: "unavailable", reason: "provider_not_configured" };
  if (!(input.depositMyr > 0)) return { status: "unavailable", reason: "no_deposit_amount" };

  const { resolvePublicSiteUrl } = await import("@/lib/quotations/public-url.core");
  const origin = resolvePublicSiteUrl(process.env["PUBLIC_SITE_URL"]);
  const back = input.publicToken ? `${origin}/q/${input.publicToken}` : origin;
  const metadata = depositCheckoutMetadata(input.scope);

  try {
    const session = await stripeFetch<{ id?: string; url?: string }>("/checkout/sessions", {
      method: "POST",
      body: {
        mode: "payment",
        client_reference_id: input.scope.agencyId,
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "myr",
              unit_amount: depositMinorUnits(input.depositMyr),
              product_data: {
                name: input.quotationNumber
                  ? `Umrah deposit — ${input.quotationNumber}`
                  : "Umrah deposit",
              },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${back}?deposit=success`,
        cancel_url: `${back}?deposit=cancelled`,
      },
      idempotencyKey: `${DEPOSIT_CHECKOUT_KIND}-${input.scope.bookingId}-${depositMinorUnits(input.depositMyr)}`,
    });

    if (!session.url) return { status: "unavailable", reason: "session_not_created" };
    return { status: "ready", url: session.url, sessionId: session.id ?? null };
  } catch (error) {
    console.error("[deposit-checkout] provider error", (error as Error).message);
    return { status: "unavailable", reason: "provider_unavailable" };
  }
}
