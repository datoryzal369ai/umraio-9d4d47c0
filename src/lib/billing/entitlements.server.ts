import type { SupabaseClient } from "@supabase/supabase-js";

import { readBillingState, resolvePaidPlan } from "./paddle-billing-state.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * UMRAIO® — CENTRAL PLAN ENTITLEMENT CONFIGURATION (Step 6.3).
 *
 * This is the ONE authoritative definition of what a plan allows. Nothing else
 * in the application may hard-code a quota, seat count or autonomy capability.
 *
 * Rules:
 * - Server-only. The browser never determines entitlement.
 * - `price` is metadata only; no payment verification exists yet.
 * - The effective plan comes from `agency_entitlements` (server-written), NOT
 *   from `agency_settings.plan`, which any authenticated user can edit today.
 */

/**
 * Legacy codes (founding/trial/growth/scale) remain resolvable for existing
 * tenants. Canonical commercial codes (basic/pro/premium/enterprise) are added
 * additively — see src/lib/billing/pricing.core.ts for the pricing truth.
 */
export type PlanCode =
  | "founding"
  | "trial"
  | "growth"
  | "scale"
  | "basic"
  | "pro"
  | "premium"
  | "enterprise";

export type AutonomyEntitlement = "off" | "assisted" | "autonomous";

export type PlanEntitlement = {
  code: PlanCode;
  label: string;
  /** Metadata only — not enforced, not charged. */
  priceMyrMonthly: number | null;
  priceNote: string;
  /** Customer-facing AI replies allowed per calendar month. */
  aiRepliesPerMonth: number;
  /** AI worker tasks allowed per calendar month. */
  aiTasksPerMonth: number;
  /**
   * VOICE V1 PREPARATION — spoken (ASR) minutes allowed per calendar month.
   * Nothing consumes this yet; voice processing is not implemented.
   */
  voiceMinutesPerMonth: number;
  whatsappNumbers: number;
  users: number;
  knowledgeArticles: number;
  storageMb: number;
  /** Highest autonomy level the plan may run at. */
  maxAutonomy: AutonomyEntitlement;
  /** Max model steps for customer-facing conversations. */
  maxConversationSteps: number;
  support: string;
};

export const PLAN_ENTITLEMENTS: Record<PlanCode, PlanEntitlement> = {
  founding: {
    code: "founding",
    label: "Founding / Early Access",
    priceMyrMonthly: 149,
    priceNote: "RM149/month during the founding period",
    aiRepliesPerMonth: 1_500,
    aiTasksPerMonth: 300,
    voiceMinutesPerMonth: 60,
    whatsappNumbers: 1,
    users: 3,
    knowledgeArticles: 50,
    storageMb: 500,
    maxAutonomy: "assisted",
    maxConversationSteps: 8,
    support: "Standard",
  },
  // Existing development/testing plans map onto the founding envelope until a
  // server-authoritative subscription system exists.
  trial: {
    code: "trial",
    label: "Trial",
    priceMyrMonthly: 0,
    priceNote: "Free during evaluation",
    aiRepliesPerMonth: 300,
    aiTasksPerMonth: 60,
    voiceMinutesPerMonth: 15,
    whatsappNumbers: 1,
    users: 3,
    knowledgeArticles: 25,
    storageMb: 250,
    maxAutonomy: "assisted",
    maxConversationSteps: 8,
    support: "Standard",
  },
  growth: {
    code: "growth",
    label: "Growth",
    priceMyrMonthly: 499,
    priceNote: "Not commercially available yet",
    aiRepliesPerMonth: 5_000,
    aiTasksPerMonth: 1_000,
    voiceMinutesPerMonth: 200,
    whatsappNumbers: 2,
    users: 10,
    knowledgeArticles: 250,
    storageMb: 2_000,
    maxAutonomy: "autonomous",
    maxConversationSteps: 12,
    support: "Priority",
  },
  scale: {
    code: "scale",
    label: "Scale",
    priceMyrMonthly: 1_299,
    priceNote: "Not commercially available yet",
    aiRepliesPerMonth: 20_000,
    aiTasksPerMonth: 4_000,
    voiceMinutesPerMonth: 600,
    whatsappNumbers: 5,
    users: 30,
    knowledgeArticles: 1_000,
    storageMb: 10_000,
    maxAutonomy: "autonomous",
    maxConversationSteps: 12,
    support: "Dedicated",
  },
  // Canonical commercial plans (Step 3G.1). Prices mirror pricing.core.ts.
  basic: {
    code: "basic",
    label: "Basic",
    priceMyrMonthly: 199,
    priceNote: "RM199/month",
    aiRepliesPerMonth: 1_500,
    aiTasksPerMonth: 300,
    voiceMinutesPerMonth: 60,
    whatsappNumbers: 1,
    users: 3,
    knowledgeArticles: 50,
    storageMb: 500,
    maxAutonomy: "assisted",
    maxConversationSteps: 8,
    support: "Standard",
  },
  pro: {
    code: "pro",
    label: "Pro",
    priceMyrMonthly: 299,
    priceNote: "RM299/month founding price · reference RM499/month",
    aiRepliesPerMonth: 5_000,
    aiTasksPerMonth: 1_000,
    voiceMinutesPerMonth: 200,
    whatsappNumbers: 2,
    users: 10,
    knowledgeArticles: 250,
    storageMb: 2_000,
    maxAutonomy: "autonomous",
    maxConversationSteps: 12,
    support: "Priority",
  },
  premium: {
    code: "premium",
    label: "Premium",
    priceMyrMonthly: 799,
    priceNote: "RM799/month",
    aiRepliesPerMonth: 20_000,
    aiTasksPerMonth: 4_000,
    voiceMinutesPerMonth: 600,
    whatsappNumbers: 5,
    users: 30,
    knowledgeArticles: 1_000,
    storageMb: 10_000,
    maxAutonomy: "autonomous",
    maxConversationSteps: 12,
    support: "Dedicated",
  },
  enterprise: {
    code: "enterprise",
    label: "Enterprise",
    priceMyrMonthly: null,
    priceNote: "Custom pricing — confirmed with the UMRAIO team",
    aiRepliesPerMonth: 50_000,
    aiTasksPerMonth: 10_000,
    voiceMinutesPerMonth: 2000,
    whatsappNumbers: 10,
    users: 100,
    knowledgeArticles: 5_000,
    storageMb: 50_000,
    maxAutonomy: "autonomous",
    maxConversationSteps: 12,
    support: "Dedicated",
  },
};

/**
 * Commercial rule: NO CONFIRMED PAYMENT → NO PAID ENTITLEMENT.
 * Agencies without a verified subscription sit on the free trial envelope.
 */
export const DEFAULT_PLAN: PlanCode = "trial";


function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && value in PLAN_ENTITLEMENTS;
}

/**
 * Development / testing override (Step 6.3 §13).
 *
 * `UMRAIO_PLAN_OVERRIDES` is a server-only JSON map of agency id -> plan code.
 * It is read inside the handler, never exposed to the browser, and cannot be
 * influenced by an ordinary agency user.
 */
function readEnvOverride(agencyId: string): PlanCode | null {
  const raw = process.env["UMRAIO_PLAN_OVERRIDES"];
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    const value = map[agencyId];
    return isPlanCode(value) ? value : null;
  } catch {
    return null;
  }
}

export type ResolvedEntitlement = {
  agencyId: string;
  plan: PlanEntitlement;
  /** What the user asked for in the UI — informational only. */
  requestedPlan: string | null;
  /** Where the effective plan came from. */
  source: "override" | "verified_billing" | "entitlement_row" | "default";
  /** True when the plan is backed by a verified provider subscription. */
  paid: boolean;
  founding: boolean;
};

/**
 * Resolve the SERVER-AUTHORITATIVE entitlement for an agency.
 * Never accepts a plan from client input.
 */
export async function resolveEntitlement(
  supabase: Db,
  agencyId: string,
): Promise<ResolvedEntitlement> {
  const override = readEnvOverride(agencyId);
  if (override) {
    return {
      agencyId,
      plan: PLAN_ENTITLEMENTS[override],
      requestedPlan: null,
      source: "override",
      paid: false,
      founding: override === "founding",
    };
  }

  const { data } = await supabase
    .from("agency_entitlements")
    .select("effective_plan, requested_plan, overrides")
    .eq("agency_id", agencyId)
    .maybeSingle();

  const requestedPlan = (data?.requested_plan as string | null) ?? null;

  // 1) Verified billing state always wins over any stored/declared plan.
  const billing = readBillingState(data?.overrides);
  const paid = resolvePaidPlan(billing);
  if (paid.plan) {
    return {
      agencyId,
      plan: PLAN_ENTITLEMENTS[paid.plan],
      requestedPlan,
      source: "verified_billing",
      paid: true,
      founding: paid.founding,
    };
  }

  const effective = data?.effective_plan;
  if (isPlanCode(effective)) {
    return {
      agencyId,
      plan: PLAN_ENTITLEMENTS[effective],
      requestedPlan,
      source: "entitlement_row",
      paid: false,
      founding: effective === "founding",
    };
  }

  return {
    agencyId,
    plan: PLAN_ENTITLEMENTS[DEFAULT_PLAN],
    requestedPlan,
    source: "default",
    paid: false,
    founding: false,
  };
}


/**
 * Record what the agency *requested* in the UI without granting it.
 * Uses a privileged client because agency users may not write entitlements.
 */
export async function recordRequestedPlan(
  supabase: Db,
  agencyId: string,
  requestedPlan: string,
): Promise<void> {
  await supabase
    .from("agency_entitlements")
    .upsert(
      { agency_id: agencyId, requested_plan: requestedPlan },
      { onConflict: "agency_id", ignoreDuplicates: false },
    );
}

/** Clamp a desired autonomy mode to what the plan permits. */
export function clampAutonomy(
  desired: AutonomyEntitlement,
  plan: PlanEntitlement,
): AutonomyEntitlement {
  const order: AutonomyEntitlement[] = ["off", "assisted", "autonomous"];
  return order.indexOf(desired) <= order.indexOf(plan.maxAutonomy) ? desired : plan.maxAutonomy;
}
