import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * UMRAIO® — server-side Stripe checkout (Step 3H.2B).
 *
 * The browser sends ONLY a canonical plan ID (`basic` | `pro` | `premium`).
 * The server resolves the Stripe price ID, verifies its currency (MYR), amount
 * and monthly recurrence against `pricing.core.ts`, and creates the Checkout
 * Session. No price, amount, currency, provider price ID or entitlement is
 * ever accepted from the client, and reaching checkout grants nothing —
 * entitlement is written only by the signature-verified webhook.
 */

export type CheckoutPreparation =
  | { status: "ready"; plan: string; founding: boolean; url: string }
  | { status: "not_self_serve"; plan: "enterprise" }
  | { status: "unavailable"; reason: string };

export type CheckoutAvailability = {
  available: boolean;
  mode: "test" | "live" | null;
  reason: string | null;
};

async function resolveAgencyId(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  userId: string,
): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  const agencyId = data?.agency_id as string | undefined;
  if (!agencyId) throw new Error("No agency found for this account.");
  return agencyId;
}

export const prepareCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { plan: string }) => ({ plan: String(data?.plan ?? "") }))
  .handler(async ({ data, context }): Promise<CheckoutPreparation> => {
    const { supabase, userId } = context;

    const { selectStripePlan, stripePriceIdFor, verifyStripePrice } = await import(
      "./stripe-mapping.core"
    );
    const selection = selectStripePlan(data.plan);
    if (!selection.ok) {
      if (selection.reason === "not_self_serve") return { status: "not_self_serve", plan: "enterprise" };
      throw new Error("Unknown plan.");
    }
    const mapping = selection.mapping;

    const agencyId = await resolveAgencyId(supabase, userId);

    const { hasStripeSecretKey, stripeFetch, getStripeMode } = await import("@/lib/stripe.server");
    if (!hasStripeSecretKey()) return { status: "unavailable", reason: "provider_not_configured" };

    const priceId = stripePriceIdFor(mapping, process.env);
    if (!priceId) return { status: "unavailable", reason: "price_not_configured" };

    // Record the request (never a grant) so the team can see intent.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { recordRequestedPlan } = await import("./entitlements.server");
    await recordRequestedPlan(supabaseAdmin as never, agencyId, mapping.plan);

    try {
      // Verify the configured price really is the canonical MYR monthly offer.
      const price = await stripeFetch<{
        active?: boolean;
        currency?: string;
        unit_amount?: number | null;
        recurring?: { interval?: string; interval_count?: number } | null;
      }>(`/prices/${encodeURIComponent(priceId)}`);
      const verification = verifyStripePrice(price, mapping);
      if (!verification.ok) {
        console.error(`[checkout] price verification failed: ${verification.reason}`);
        return { status: "unavailable", reason: `price_${verification.reason}` };
      }

      // Reuse the agency's Stripe customer where one already exists.
      const { data: entitlementRow } = await (supabaseAdmin as never as { from: (t: string) => any }) // eslint-disable-line @typescript-eslint/no-explicit-any
        .from("agency_entitlements")
        .select("overrides")
        .eq("agency_id", agencyId)
        .maybeSingle();
      const overrides = (entitlementRow?.overrides ?? {}) as Record<string, unknown>;
      let customerId = typeof overrides["stripe_customer_id"] === "string"
        ? (overrides["stripe_customer_id"] as string)
        : null;

      const { data: userRow } = await supabase.auth.getUser();
      const email = userRow?.user?.email ?? undefined;

      if (!customerId) {
        const customer = await stripeFetch<{ id: string }>("/customers", {
          method: "POST",
          body: { email, metadata: { agency_id: agencyId, user_id: userId } },
          idempotencyKey: `umraio-customer-${agencyId}`,
        });
        customerId = customer.id;
        await (supabaseAdmin as never as { from: (t: string) => any }) // eslint-disable-line @typescript-eslint/no-explicit-any
          .from("agency_entitlements")
          .upsert(
            {
              agency_id: agencyId,
              overrides: { ...overrides, stripe_customer_id: customerId },
            },
            { onConflict: "agency_id" },
          );
      }

      const origin = process.env["PUBLIC_SITE_URL"] ?? "https://umraio.com";
      const session = await stripeFetch<{ url?: string }>("/checkout/sessions", {
        method: "POST",
        body: {
          mode: "subscription",
          customer: customerId,
          client_reference_id: agencyId,
          line_items: [{ price: priceId, quantity: 1 }],
          allow_promotion_codes: false,
          metadata: { agency_id: agencyId, plan: mapping.plan, user_id: userId },
          subscription_data: {
            metadata: {
              agency_id: agencyId,
              plan: mapping.plan,
              founding: String(mapping.founding),
              user_id: userId,
            },
          },
          success_url: `${origin}/settings/subscription?checkout=success`,
          cancel_url: `${origin}/settings/subscription?checkout=cancelled`,
        },
      });

      if (!session.url) return { status: "unavailable", reason: "session_not_created" };

      console.log(
        `[checkout] session created agency=${agencyId} plan=${mapping.plan} mode=${getStripeMode()}`,
      );
      return { status: "ready", plan: mapping.plan, founding: mapping.founding, url: session.url };
    } catch (error) {
      console.error("[checkout] provider error", error);
      return { status: "unavailable", reason: "provider_unavailable" };
    }
  });

/**
 * Whether a real self-serve checkout can currently be completed. Used only to
 * pick honest CTA wording and the test-mode banner — it never grants anything.
 */
export const getCheckoutAvailability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<CheckoutAvailability> => {
    const { hasStripeSecretKey, getStripeMode } = await import("@/lib/stripe.server");
    if (!hasStripeSecretKey()) {
      return { available: false, mode: null, reason: "provider_not_configured" };
    }
    const mode = getStripeMode();

    const { STRIPE_PLAN_MAP, stripePriceIdFor } = await import("./stripe-mapping.core");
    const missing = Object.values(STRIPE_PLAN_MAP).filter(
      (mapping) => !stripePriceIdFor(mapping, process.env),
    );
    if (missing.length > 0) return { available: false, mode, reason: "price_not_configured" };

    return { available: true, mode, reason: null };
  });

/** Secure Stripe customer portal link for managing an existing subscription. */
export const openBillingPortal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ url: string } | { error: string }> => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { hasStripeSecretKey, stripeFetch } = await import("@/lib/stripe.server");
    if (!hasStripeSecretKey()) return { error: "provider_not_configured" };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await (supabaseAdmin as never as { from: (t: string) => any }) // eslint-disable-line @typescript-eslint/no-explicit-any
      .from("agency_entitlements")
      .select("overrides")
      .eq("agency_id", agencyId)
      .maybeSingle();
    const overrides = (row?.overrides ?? {}) as Record<string, unknown>;
    const billing = overrides["billing"] as { customer_id?: string } | undefined;
    const customerId =
      (typeof overrides["stripe_customer_id"] === "string"
        ? (overrides["stripe_customer_id"] as string)
        : null) ?? billing?.customer_id ?? null;

    if (!customerId) return { error: "no_customer" };

    const origin = process.env["PUBLIC_SITE_URL"] ?? "https://umraio.com";
    try {
      const session = await stripeFetch<{ url?: string }>("/billing_portal/sessions", {
        method: "POST",
        body: { customer: customerId, return_url: `${origin}/settings/subscription` },
      });
      return session.url ? { url: session.url } : { error: "portal_unavailable" };
    } catch {
      return { error: "portal_unavailable" };
    }
  });

/**
 * Server-authoritative subscription status for the signed-in agency.
 * Read-only: it reports what verified billing already granted and never grants
 * anything itself. The browser uses it for display and for the post-checkout
 * activation state — it can never be used to escalate a plan.
 */
export type BillingStatus = {
  plan: string;
  planLabel: string;
  paid: boolean;
  founding: boolean;
  source: string;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingDowngradePlan: string | null;
};

export const getBillingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BillingStatus> => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { resolveEntitlement } = await import("./entitlements.server");
    const { readBillingState } = await import("./paddle-billing-state.core");

    const entitlement = await resolveEntitlement(supabase as never, agencyId);

    const { data: row } = await supabase
      .from("agency_entitlements")
      .select("overrides")
      .eq("agency_id", agencyId)
      .maybeSingle();
    const billing = readBillingState((row as { overrides?: unknown } | null)?.overrides);

    return {
      plan: entitlement.plan.code,
      planLabel: entitlement.plan.label,
      paid: entitlement.paid,
      founding: entitlement.founding,
      source: entitlement.source,
      status: billing?.status ?? null,
      currentPeriodEnd: billing?.current_period_end ?? null,
      cancelAtPeriodEnd: Boolean(billing?.cancel_at_period_end),
      pendingDowngradePlan: billing?.pending_downgrade?.plan ?? null,
    };
  });
