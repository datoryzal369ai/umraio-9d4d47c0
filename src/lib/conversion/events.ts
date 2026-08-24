import type { SupabaseClient } from "@supabase/supabase-js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ConversionDb = SupabaseClient<any, any, any>;

export type ConversionActor = "ai" | "human" | "customer" | "system";

export type ConversionEventInput = {
  agencyId: string;
  stage: string;
  actor?: ConversionActor;
  leadId?: string | null;
  quotationId?: string | null;
  bookingId?: string | null;
  reason?: string | null;
  meta?: Record<string, unknown>;
};

/**
 * B-1 — single authoritative write path for conversion telemetry.
 *
 * Client-safe module (no server-only imports) so browser CRM flows and server
 * functions share one producer. Tenant scoping is enforced by RLS: the insert
 * must satisfy `agency_id = private.current_agency_id()` for authenticated
 * callers; the agency id is never taken from untrusted browser input, only
 * from the row/session the caller already resolved.
 */
export async function logConversionEvent(supabase: ConversionDb, input: ConversionEventInput) {
  const { error } = await supabase.from("conversion_events").insert({
    agency_id: input.agencyId,
    stage: input.stage,
    actor: input.actor ?? "ai",
    lead_id: input.leadId ?? null,
    quotation_id: input.quotationId ?? null,
    booking_id: input.bookingId ?? null,
    reason: input.reason ?? null,
    meta: input.meta ?? {},
  });

  // Telemetry is best-effort: a failure must never break the business
  // transaction, but it must be observable. No PII is logged — only the
  // event shape and the database error code/message.
  if (error) {
    console.error(
      `[conversion-telemetry] insert_failed stage=${input.stage} actor=${input.actor ?? "ai"} ` +
        `agency=${input.agencyId} code=${error.code ?? "unknown"} message=${error.message}`,
    );
    return { ok: false as const, error };
  }
  return { ok: true as const, error: null };
}
