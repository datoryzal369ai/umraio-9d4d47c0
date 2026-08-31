import { describe, expect, test } from "vitest";

import {
  applySubscriptionEvent,
  emptyBillingState,
  resolvePaidPlan,
  type PaddleSubscriptionEvent,
} from "../src/lib/billing/paddle-billing-state.core";
import {
  PADDLE_PLAN_MAP,
  classifyPlanChange,
  isPaidStatus,
  planFromPriceExternalId,
  selectPlan,
} from "../src/lib/billing/paddle-mapping.core";

const base = (over: Partial<PaddleSubscriptionEvent> = {}): PaddleSubscriptionEvent => ({
  eventId: "evt_1",
  type: "created",
  environment: "sandbox",
  subscriptionId: "sub_1",
  customerId: "ctm_1",
  priceExternalId: PADDLE_PLAN_MAP.pro.priceExternalId,
  status: "active",
  currentPeriodEnd: "2999-01-01T00:00:00.000Z",
  occurredAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("plan mapping", () => {
  test("only basic/pro/premium are self-serve", () => {
    expect(selectPlan("basic").ok).toBe(true);
    expect(selectPlan("premium").ok).toBe(true);
    const enterprise = selectPlan("enterprise");
    expect(enterprise.ok).toBe(false);
    if (!enterprise.ok) expect(enterprise.reason).toBe("not_self_serve");
    expect(selectPlan("free").ok).toBe(false);
  });

  test("price external ids resolve back to a canonical plan", () => {
    expect(planFromPriceExternalId(PADDLE_PLAN_MAP.basic.priceExternalId)?.plan).toBe("basic");
    expect(planFromPriceExternalId("umraio_unknown")).toBeNull();
  });

  test("plan change classification drives upgrade/downgrade timing", () => {
    expect(classifyPlanChange(null, "pro")).toBe("activation");
    expect(classifyPlanChange("basic", "premium")).toBe("upgrade");
    expect(classifyPlanChange("premium", "basic")).toBe("downgrade");
    expect(classifyPlanChange("pro", "pro")).toBe("same");
  });

  test("paid statuses are explicit", () => {
    expect(isPaidStatus("active")).toBe(true);
    expect(isPaidStatus("past_due")).toBe(true);
    expect(isPaidStatus("canceled")).toBe(false);
  });
});

describe("billing state machine", () => {
  test("activation grants the plan, resets usage and notifies", () => {
    const { state, effects } = applySubscriptionEvent(null, base());
    expect(state.plan).toBe("pro");
    expect(state.founding).toBe(true);
    expect(effects.effectivePlan).toBe("pro");
    expect(effects.resetUsagePeriod).toBe(true);
    expect(effects.notify).toBe("activated");
  });

  test("duplicate event ids are ignored (idempotency)", () => {
    const first = applySubscriptionEvent(null, base());
    const second = applySubscriptionEvent(first.state, base());
    expect(second.effects.ignored).toBe(true);
    expect(second.state.plan).toBe("pro");
  });

  test("upgrade applies immediately", () => {
    const first = applySubscriptionEvent(null, base({ priceExternalId: PADDLE_PLAN_MAP.basic.priceExternalId }));
    const upgraded = applySubscriptionEvent(
      first.state,
      base({
        eventId: "evt_2",
        type: "updated",
        priceExternalId: PADDLE_PLAN_MAP.premium.priceExternalId,
      }),
    );
    expect(upgraded.effects.effectivePlan).toBe("premium");
    expect(upgraded.state.pending_downgrade).toBeNull();
  });

  test("downgrade is scheduled, not immediate", () => {
    const first = applySubscriptionEvent(
      null,
      base({ priceExternalId: PADDLE_PLAN_MAP.premium.priceExternalId }),
    );
    const down = applySubscriptionEvent(
      first.state,
      base({
        eventId: "evt_3",
        type: "updated",
        priceExternalId: PADDLE_PLAN_MAP.basic.priceExternalId,
      }),
    );
    expect(down.effects.effectivePlan).toBe("premium");
    expect(down.state.pending_downgrade?.plan).toBe("basic");
    expect(down.effects.notify).toBe("downgrade_scheduled");
  });

  test("cancellation keeps access until the period ends, then drops", () => {
    const first = applySubscriptionEvent(null, base());
    const canceled = applySubscriptionEvent(
      first.state,
      base({
        eventId: "evt_4",
        type: "canceled",
        status: "canceled",
        currentPeriodEnd: "2999-01-01T00:00:00.000Z",
      }),
    );
    expect(resolvePaidPlan(canceled.state).plan).toBe("pro");

    const expired = { ...canceled.state, current_period_end: "2020-01-01T00:00:00.000Z" };
    expect(resolvePaidPlan(expired).plan).toBeNull();
  });

  test("an empty state grants nothing", () => {
    expect(resolvePaidPlan(emptyBillingState("sub_x", "sandbox")).plan).toBeNull();
    expect(resolvePaidPlan(null).plan).toBeNull();
  });
});
