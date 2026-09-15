/**
 * UMRAIO® — Stripe-hosted Checkout creation for commercial payments
 * (server-only).
 *
 * Reuses the existing `stripe.server` REST helper — no second payment system,
 * no SDK, no client-side secret. The amount arrives already derived from the
 * quotation by `payment.server`; nothing here trusts a client value. Reaching
 * the returned URL grants nothing: only the signature-verified webhook can
 * mark a payment succeeded.
 */
import {
  checkoutProductName,
  paymentCheckoutMetadata,
  paymentMinorUnits,
  type PaymentScope,
} from "@/lib/payments/payment.core";

export type PaymentCheckoutResult =
  | { status: "ready"; url: string; sessionId: string | null }
  | { status: "unavailable"; reason: string };

export async function createPaymentCheckoutSession(input: {
  scope: PaymentScope;
  amountMyr: number;
  quotationNumber?: string | null;
  publicToken?: string | null;
  customerEmail?: string | null;
}): Promise<PaymentCheckoutResult> {
  const { hasStripeSecretKey, stripeFetch } = await import("@/lib/stripe.server");
  if (!hasStripeSecretKey()) return { status: "unavailable", reason: "provider_not_configured" };
  if (!(input.amountMyr > 0)) return { status: "unavailable", reason: "no_amount" };

  const { resolvePublicSiteUrl } = await import("@/lib/quotations/public-url.core");
  const origin = resolvePublicSiteUrl(process.env["PUBLIC_SITE_URL"]);
  const back = input.publicToken ? `${origin}/q/${input.publicToken}` : origin;
  const metadata = paymentCheckoutMetadata(input.scope);
  const unitAmount = paymentMinorUnits(input.amountMyr);

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
              unit_amount: unitAmount,
              product_data: {
                name: checkoutProductName(input.scope.kind, input.quotationNumber ?? null),
              },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
        // The browser return is informational only.
        success_url: `${back}?payment=processing`,
        cancel_url: `${back}?payment=cancelled`,
      },
      idempotencyKey: `umraio-payment-${input.scope.paymentId}-${unitAmount}`,
    });

    if (!session.url) return { status: "unavailable", reason: "session_not_created" };
    return { status: "ready", url: session.url, sessionId: session.id ?? null };
  } catch (error) {
    console.error("[payment-checkout] provider error", (error as Error).message);
    return { status: "unavailable", reason: "provider_unavailable" };
  }
}
