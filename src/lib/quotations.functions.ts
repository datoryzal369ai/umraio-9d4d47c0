/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Quotation server functions.
 *
 * Pricing is never computed in the browser and never by a model — the handler
 * recomputes every figure from the agency's own package and deposit policy.
 */

const createSchema = z.object({
  packageId: z.string().uuid(),
  pilgrims: z.number().int().min(1).max(200),
  leadId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  travelMonth: z.string().max(60).nullable().optional(),
  customerName: z.string().max(140).nullable().optional(),
  customerPhone: z.string().max(40).nullable().optional(),
  discount: z.number().min(0).max(1_000_000).optional(),
  notes: z.string().max(1000).nullable().optional(),
});

async function agencyOf(supabase: any, userId: string) {
  const { data } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  const agencyId = data?.agency_id as string | undefined;
  if (!agencyId) throw new Error("No agency found for this account.");
  return agencyId;
}

export const listLeadQuotations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { leadId: string }) =>
    z.object({ leadId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("quotations")
      .select("*")
      .eq("lead_id", data.leadId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const listAgencyPackages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("packages")
      .select("id, name, price_myr, nights, star_rating, departure_date")
      .eq("is_active", true)
      .order("price_myr", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createQuotationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => createSchema.parse(input))
  .handler(async ({ data, context }) => {
    const agencyId = await agencyOf(context.supabase, context.userId);
    const { createQuotation } = await import("./quotations/quotations.server");
    return createQuotation(context.supabase as never, agencyId, {
      packageId: data.packageId,
      pilgrims: data.pilgrims,
      leadId: data.leadId ?? null,
      conversationId: data.conversationId ?? null,
      travelMonth: data.travelMonth ?? null,
      customerName: data.customerName ?? null,
      customerPhone: data.customerPhone ?? null,
      notes: data.notes ?? null,
      ...(data.discount !== undefined ? { discount: data.discount } : {}),
      createdBy: context.userId,
    });
  });

export const transitionQuotationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        quotationId: z.string().uuid(),
        status: z.enum([
          "ready",
          "sent",
          "viewed",
          "discussing",
          "accepted",
          "deposit_pending",
          "deposit_paid",
          "booked",
          "rejected",
          "expired",
          "cancelled",
        ]),
        reason: z.string().max(400).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const agencyId = await agencyOf(context.supabase, context.userId);
    const { transitionQuotation } = await import("./quotations/quotations.server");
    return transitionQuotation(context.supabase as never, agencyId, data.quotationId, data.status, {
      actor: "human",
      reason: data.reason ?? null,
    });
  });

/** Hashed-IP gate for the two unauthenticated quotation endpoints (P1-2). */
async function publicQuotationGate(action: "read" | "respond") {
  const {
    checkPublicQuotationRate,
    PUBLIC_QUOTATION_RATE_MESSAGE,
  } = await import("./quotations/public-rate-limit.core");
  let ipHash = "";
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const { clientIpHash } = await import("./billing/demo-limit.server");
    ipHash = clientIpHash(getRequest());
  } catch {
    return; // Fail open when the request context is unavailable.
  }
  if (!checkPublicQuotationRate(action, ipHash).allowed) {
    throw new Error(PUBLIC_QUOTATION_RATE_MESSAGE);
  }
}

/** Public, token-gated read for the customer review page. */
export const getPublicQuotation = createServerFn({ method: "GET" })
  .inputValidator((input: { token: string }) =>
    z.object({ token: z.string().regex(/^[a-f0-9]{16,64}$/) }).parse(input),
  )
  .handler(async ({ data }) => {
    await publicQuotationGate("read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { readQuotationByToken } = await import("./quotations/quotations.server");
    return readQuotationByToken(supabaseAdmin as never, data.token);
  });

/** Public, token-gated customer decision. Never charges anything. */
export const respondPublicQuotation = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        token: z.string().regex(/^[a-f0-9]{16,64}$/),
        decision: z.enum(["accepted", "rejected"]),
        reason: z.string().max(400).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await publicQuotationGate("respond");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { respondToQuotationByToken } = await import("./quotations/quotations.server");
    await respondToQuotationByToken(
      supabaseAdmin as never,
      data.token,
      data.decision,
      data.reason ?? null,
    );
    return { ok: true };
  });

