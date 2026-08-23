import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAN,
  PLAN_ENTITLEMENTS,
} from "@/lib/billing/entitlements.server";
import { normalizeStripeEvent } from "@/lib/billing/stripe-billing.server";
import {
  STRIPE_PLAN_MAP,
  selectStripePlan,
  stripePriceIdFor,
} from "@/lib/billing/stripe-mapping.core";
import {
  applySubscriptionEvent,
  isDuplicateEvent,
  resolvePaidPlan,
  type PaddleSubscriptionEvent,
} from "@/lib/billing/paddle-billing-state.core";

/**
 * UMRAIO® — COMMERCIAL READINESS (Stripe) regression suite.
 * Covers the payment → entitlement contract end to end at the pure layer.
 */

const ENV = {
  STRIPE_PRICE_BASIC_MYR_MONTHLY: "price_basic",
  STRIPE_PRICE_PRO_FOUNDING_MYR_MONTHLY: "price_pro",
  STRIPE_PRICE_PREMIUM_MYR_MONTHLY: "price_premium",
};

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_checkout_1",
    type: "checkout.session.completed",
    created: 1_700_000_000,
    data: {
      object: {
        id: "cs_1",
        mode: "subscription",
        payment_status: "paid",
        subscription: "sub_1",
        customer: "cus_1",
        client_reference_id: "agency-1",
        metadata: { plan: "pro", agency_id: "agency-1" },
        ...overrides,
      },
    },
  };
}

describe("checkout.session.completed → verified activation", () => {
  it("activates the purchased plan for the correct agency", () => {
    const normalized = normalizeStripeEvent(checkoutSession(), ENV, "test");
    expect(normalized).not.toBeNull();
    expect(normalized!.agencyId).toBe("agency-1");
    expect(normalized!.customerId).toBe("cus_1");
    expect(normalized!.event.subscriptionId).toBe("sub_1");
    expect(normalized!.event.type).toBe("created");
    expect(normalized!.event.environment).toBe("sandbox");
    expect(normalized!.event.priceExternalId).toBe(STRIPE_PLAN_MAP.pro.priceExternalId);
  });

  it("ignores unpaid or non-subscription sessions (no free entitlement)", () => {
    expect(normalizeStripeEvent(checkoutSession({ payment_status: "unpaid" }), ENV, "test")).toBeNull();
    expect(normalizeStripeEvent(checkoutSession({ mode: "payment" }), ENV, "test")).toBeNull();
    expect(normalizeStripeEvent(checkoutSession({ subscription: null }), ENV, "test")).toBeNull();
  });

  it("refuses to map an unknown plan smuggled through session metadata", () => {
    const normalized = normalizeStripeEvent(
      checkoutSession({ metadata: { plan: "enterprise_free", agency_id: "agency-1" } }),
      ENV,
      "test",
    );
    expect(normalized!.event.priceExternalId).toBeNull();
    const applied = applySubscriptionEvent(null, normalized!.event);
    expect(applied.effects.ignored).toBe(true);
    expect(applied.effects.effectivePlan).toBeNull();
  });
});

describe("invoice lifecycle", () => {
  const invoice = (type: string, priceId: string) => ({
    id: `evt_${type}`,
    type,
    created: 1_700_000_100,
    data: {
      object: {
        subscription: "sub_1",
        customer: "cus_1",
        lines: { data: [{ price: { id: priceId }, period: { end: 1_800_000_000 } }] },
      },
    },
  });

  it("treats invoice.paid as a renewal update", () => {
    const normalized = normalizeStripeEvent(invoice("invoice.paid", "price_pro"), ENV, "test");
    expect(normalized!.event.type).toBe("updated");
    expect(normalized!.event.status).toBe("active");
    expect(normalized!.event.priceExternalId).toBe(STRIPE_PLAN_MAP.pro.priceExternalId);
  });

  it("marks a failed payment past_due without revoking access", () => {
    const normalized = normalizeStripeEvent(
      invoice("invoice.payment_failed", "price_pro"),
      ENV,
      "test",
    );
    expect(normalized!.event.type).toBe("payment_failed");
    const active = applySubscriptionEvent(null, {
      eventId: "evt_a",
      type: "created",
      environment: "sandbox",
      subscriptionId: "sub_1",
      priceExternalId: STRIPE_PLAN_MAP.pro.priceExternalId,
      status: "active",
      occurredAt: new Date().toISOString(),
    });
    const failed = applySubscriptionEvent(active.state, normalized!.event);
    expect(failed.state.status).toBe("past_due");
    expect(failed.effects.effectivePlan).toBe("pro");
    expect(failed.effects.notify).toBe("payment_failed");
  });
});

describe("idempotency", () => {
  const event: PaddleSubscriptionEvent = {
    eventId: "evt_dup",
    type: "created",
    environment: "sandbox",
    subscriptionId: "sub_1",
    priceExternalId: STRIPE_PLAN_MAP.pro.priceExternalId,
    status: "active",
    occurredAt: new Date().toISOString(),
  };

  it("absorbs duplicate webhook deliveries", () => {
    const first = applySubscriptionEvent(null, event);
    expect(first.effects.notify).toBe("activated");
    expect(isDuplicateEvent(first.state, event.eventId)).toBe(true);

    const second = applySubscriptionEvent(first.state, event);
    expect(second.effects.ignored).toBe(true);
    expect(second.effects.notify).toBeNull();
    expect(second.state.processed_events.filter((id) => id === event.eventId)).toHaveLength(1);
  });
});

describe("cancellation and expiry", () => {
  it("keeps access until period end, then revokes", () => {
    const active = applySubscriptionEvent(null, {
      eventId: "evt_a",
      type: "created",
      environment: "sandbox",
      subscriptionId: "sub_1",
      priceExternalId: STRIPE_PLAN_MAP.pro.priceExternalId,
      status: "active",
      currentPeriodEnd: "2030-01-01T00:00:00.000Z",
      occurredAt: "2029-12-01T00:00:00.000Z",
    });
    const cancelled = applySubscriptionEvent(active.state, {
      eventId: "evt_c",
      type: "canceled",
      environment: "sandbox",
      subscriptionId: "sub_1",
      currentPeriodEnd: "2030-01-01T00:00:00.000Z",
      occurredAt: "2029-12-05T00:00:00.000Z",
    });
    expect(resolvePaidPlan(cancelled.state, new Date("2029-12-20T00:00:00Z")).plan).toBe("pro");
    expect(resolvePaidPlan(cancelled.state, new Date("2030-01-02T00:00:00Z")).plan).toBeNull();
  });
});

describe("upgrade and downgrade", () => {
  const base = applySubscriptionEvent(null, {
    eventId: "evt_basic",
    type: "created",
    environment: "sandbox",
    subscriptionId: "sub_1",
    priceExternalId: STRIPE_PLAN_MAP.basic.priceExternalId,
    status: "active",
    currentPeriodEnd: "2030-01-01T00:00:00.000Z",
    occurredAt: "2029-12-01T00:00:00.000Z",
  }).state;

  it("applies an upgrade immediately", () => {
    const up = applySubscriptionEvent(base, {
      eventId: "evt_up",
      type: "updated",
      environment: "sandbox",
      subscriptionId: "sub_1",
      priceExternalId: STRIPE_PLAN_MAP.premium.priceExternalId,
      status: "active",
      currentPeriodEnd: "2030-01-01T00:00:00.000Z",
      occurredAt: "2029-12-10T00:00:00.000Z",
    });
    expect(up.effects.effectivePlan).toBe("premium");
    expect(up.effects.notify).toBe("upgraded");
    expect(up.effects.resetUsagePeriod).toBe(true);
  });

  it("defers a downgrade to period end", () => {
    const pro = applySubscriptionEvent(base, {
      eventId: "evt_pro",
      type: "updated",
      environment: "sandbox",
      subscriptionId: "sub_1",
      priceExternalId: STRIPE_PLAN_MAP.premium.priceExternalId,
      status: "active",
      currentPeriodEnd: "2030-01-01T00:00:00.000Z",
      occurredAt: "2029-12-10T00:00:00.000Z",
    }).state;
    const down = applySubscriptionEvent(pro, {
      eventId: "evt_down",
      type: "updated",
      environment: "sandbox",
      subscriptionId: "sub_1",
      priceExternalId: STRIPE_PLAN_MAP.basic.priceExternalId,
      status: "active",
      currentPeriodEnd: "2030-01-01T00:00:00.000Z",
      occurredAt: "2029-12-15T00:00:00.000Z",
    });
    expect(down.effects.notify).toBe("downgrade_scheduled");
    expect(resolvePaidPlan(down.state, new Date("2029-12-20T00:00:00Z")).plan).toBe("premium");
    expect(resolvePaidPlan(down.state, new Date("2030-01-02T00:00:00Z")).plan).toBe("basic");
  });
});

describe("no paid access without verified payment", () => {
  it("defaults to the free trial envelope", () => {
    expect(DEFAULT_PLAN).toBe("trial");
    expect(PLAN_ENTITLEMENTS[DEFAULT_PLAN].priceMyrMonthly).toBe(0);
    expect(PLAN_ENTITLEMENTS[DEFAULT_PLAN].aiRepliesPerMonth).toBeLessThan(
      PLAN_ENTITLEMENTS.pro.aiRepliesPerMonth,
    );
  });

  it("cannot be escalated by client-supplied plan input", () => {
    expect(selectStripePlan("enterprise").ok).toBe(false);
    expect(selectStripePlan("founding").ok).toBe(false);
    expect(stripePriceIdFor(STRIPE_PLAN_MAP.pro, { STRIPE_PRICE_PRO_FOUNDING_MYR_MONTHLY: "hack" })).toBeNull();
  });

  it("keeps agencies isolated — an event only ever carries one agency id", () => {
    const a = normalizeStripeEvent(checkoutSession(), ENV, "test");
    const b = normalizeStripeEvent(
      checkoutSession({
        id: "cs_2",
        subscription: "sub_2",
        client_reference_id: "agency-2",
        metadata: { plan: "basic", agency_id: "agency-2" },
      }),
      ENV,
      "test",
    );
    expect(a!.agencyId).toBe("agency-1");
    expect(b!.agencyId).toBe("agency-2");
    expect(a!.event.subscriptionId).not.toBe(b!.event.subscriptionId);
  });
});
