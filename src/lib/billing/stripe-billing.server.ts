import type { SupabaseClient } from "@supabase/supabase-js";

import { applyVerifiedSubscriptionEvent, type ApplyOutcome } from "./paddle-billing.server";
import type { PaddleSubscriptionEvent } from "./paddle-billing-state.core";
import { STRIPE_PLAN_MAP, isPurchasablePlan, planFromStripePriceId } from "./stripe-mapping.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * UMRAIO® — Stripe → entitlement bridge (Step 3H.2B).
 *
 * Converts a VERIFIED Stripe event into the provider-neutral subscription event
 * consumed by the deterministic billing state machine. Entitlement is granted
 * nowhere else. Duplicate deliveries are absorbed by the event ledger inside
 * the state machine (idempotency).
 */

export type StripeEventEnvelope = {
  id: string;
  type: string;
  created?: number;
  data?: { object?: any };
};

/** Stripe subscription lifecycle events we act on. */
const SUBSCRIPTION_EVENTS: Record<string, PaddleSubscriptionEvent["type"]> = {
  "checkout.session.completed": "created",
  "customer.subscription.created": "created",
  "customer.subscription.updated": "updated",
  "customer.subscription.deleted": "canceled",
  "customer.subscription.paused": "updated",
  "customer.subscription.resumed": "updated",
  "invoice.paid": "updated",
  "invoice.payment_succeeded": "updated",
  "invoice.payment_failed": "payment_failed",
};

function toIso(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function stripePriceIdFromSubscription(subscription: any): string | null {
  const item = subscription?.items?.data?.[0];
  return (item?.price?.id as string | undefined) ?? null;
}


export type NormalizedStripeEvent = {
  event: PaddleSubscriptionEvent;
  agencyId: string | null;
  customerId: string | null;
};

/**
 * Normalize a verified Stripe event. Returns null for events we do not act on.
 * `env` is passed explicitly so this stays pure and unit-testable.
 */
export function normalizeStripeEvent(
  envelope: StripeEventEnvelope,
  env: Record<string, string | undefined>,
  mode: "test" | "live",
): NormalizedStripeEvent | null {
  const type = SUBSCRIPTION_EVENTS[envelope.type];
  if (!type) return null;

  const object = envelope.data?.object ?? {};
  const isInvoice = envelope.type.startsWith("invoice.");

  const subscriptionId: string | null = isInvoice
    ? ((typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id) ?? null)
    : ((object.id as string | undefined) ?? null);
  if (!subscriptionId) return null;

  const stripePriceId = isInvoice
    ? ((object?.lines?.data?.[0]?.price?.id as string | undefined) ?? null)
    : stripePriceIdFromSubscription(object);
  const mapping = planFromStripePriceId(stripePriceId, env);

  const metadata = (object.metadata ?? {}) as Record<string, string | undefined>;
  const agencyId = metadata["agency_id"] ?? metadata["agencyId"] ?? null;

  const customerId =
    typeof object.customer === "string" ? object.customer : (object.customer?.id ?? null);

  const status: string | null = isInvoice
    ? envelope.type === "invoice.payment_failed"
      ? "past_due"
      : "active"
    : ((object.status as string | undefined) ?? null);

  const currentPeriodEnd = isInvoice
    ? toIso(object?.lines?.data?.[0]?.period?.end)
    : toIso(object.current_period_end);

  return {
    agencyId,
    customerId,
    event: {
      eventId: envelope.id,
      type,
      environment: mode === "live" ? "live" : "sandbox",
      subscriptionId,
      customerId,
      priceExternalId: mapping?.priceExternalId ?? null,
      status,
      currentPeriodEnd,
      scheduledCancel: Boolean(object.cancel_at_period_end),
      occurredAt: toIso(envelope.created) ?? new Date().toISOString(),
    },
  };
}

/** Persist a verified Stripe event (idempotent, server-authoritative). */
export async function applyVerifiedStripeEvent(
  supabase: Db,
  normalized: NormalizedStripeEvent,
): Promise<ApplyOutcome> {
  return applyVerifiedSubscriptionEvent(
    supabase,
    normalized.event,
    normalized.agencyId,
    "stripe",
  );
}
