import { createFileRoute } from "@tanstack/react-router";

/**
 * UMRAIO® — Stripe webhook (Step 3H.2B).
 *
 * Public by design (Stripe sends no session). Security comes from verifying the
 * Stripe signature on EVERY request with the endpoint's signing secret.
 * Entitlement is activated here and nowhere else — never from the browser and
 * never because a checkout page was reached. Duplicate deliveries are absorbed
 * by the event ledger in the billing state machine.
 */

export const Route = createFileRoute("/api/public/payments/stripe-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { readVerifiedStripeEvent, getStripeMode } = await import("@/lib/stripe.server");

        let envelope: Record<string, unknown>;
        try {
          envelope = await readVerifiedStripeEvent(request);
        } catch (error) {
          console.warn("[stripe] rejected webhook:", (error as Error).message);
          return new Response("Invalid signature", { status: 400 });
        }

        try {
          const { normalizeStripeEvent, applyVerifiedStripeEvent } = await import(
            "@/lib/billing/stripe-billing.server"
          );
          const normalized = normalizeStripeEvent(
            envelope as never,
            process.env,
            getStripeMode(),
          );

          if (!normalized) {
            console.log(`[stripe] event=${String(envelope["type"])} label=event_ignored`);
            return Response.json({ received: true });
          }

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const outcome = await applyVerifiedStripeEvent(supabaseAdmin as never, normalized);

          // Telemetry: never logs card data, keys or personal data.
          const label = !outcome.applied
            ? outcome.reason === "duplicate"
              ? "duplicate_event_ignored"
              : outcome.reason === "no_agency"
                ? "agency_unresolved"
                : "price_unmapped"
            : envelope["type"] === "invoice.payment_failed"
              ? "payment_failed"
              : envelope["type"] === "customer.subscription.deleted"
                ? "subscription_cancelled"
                : normalized.event.type === "created"
                  ? "subscription_activated"
                  : "subscription_updated";

          console.log(
            `[stripe] event=${String(envelope["type"])} label=${label}` +
              (outcome.applied
                ? ` agency=${outcome.agencyId} plan=${outcome.effectivePlan} entitlement=${
                    outcome.effectivePlan === "trial" ? "revoked" : "activated"
                  }`
                : ""),
          );
          return Response.json({ received: true });

        } catch (error) {
          console.error("[stripe] webhook processing error", error);
          return new Response("Webhook error", { status: 500 });
        }
      },
    },
  },
});
