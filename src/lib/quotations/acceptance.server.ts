/**
 * RED-1 — WhatsApp in-chat quotation acceptance.
 *
 * Finds the quotation an explicit "SETUJU" refers to, using the tenant + lead
 * relationship (conversation_id is used when present but never required), and
 * moves it to `accepted` exactly once. No new quotation is ever created and no
 * pricing/package fact is ever rewritten.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ACCEPTABLE_QUOTATION_STATUSES,
  selectAcceptanceCandidate,
  type AcceptanceCandidate,
} from "./closing.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type AcceptQuotationResult = {
  accepted: boolean;
  reason: "accepted" | "no_scope" | "no_candidate" | "already_accepted";
  quotation?: {
    id: string;
    quotationNumber: string | null;
    totalMyr: number | null;
    depositMyr: number | null;
    leadId: string | null;
  };
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function acceptQuotationInChat(
  supabase: Db,
  scope: { agencyId: string; leadId: string | null; conversationId: string | null },
): Promise<AcceptQuotationResult> {
  if (!scope.leadId && !scope.conversationId) return { accepted: false, reason: "no_scope" };

  const orParts: string[] = [];
  if (scope.leadId) orParts.push(`lead_id.eq.${scope.leadId}`);
  if (scope.conversationId) orParts.push(`conversation_id.eq.${scope.conversationId}`);

  const { data: rows } = await supabase
    .from("quotations")
    .select("id, agency_id, lead_id, conversation_id, status, quotation_number, total, deposit_amount")
    .eq("agency_id", scope.agencyId)
    .in("status", ACCEPTABLE_QUOTATION_STATUSES as unknown as string[])
    .or(orParts.join(","))
    .order("created_at", { ascending: false })
    .limit(10);

  const candidate = selectAcceptanceCandidate((rows ?? []) as AcceptanceCandidate[], scope);
  if (!candidate) return { accepted: false, reason: "no_candidate" };

  const acceptedAt = new Date().toISOString();
  // Conditional update = idempotency: a replayed SETUJU updates zero rows.
  const { data: updated } = await supabase
    .from("quotations")
    .update({ status: "accepted", accepted_at: acceptedAt })
    .eq("id", candidate.id)
    .eq("agency_id", scope.agencyId)
    .in("status", ACCEPTABLE_QUOTATION_STATUSES as unknown as string[])
    .select("id, lead_id, quotation_number, total, deposit_amount");

  const row = ((updated ?? []) as AcceptanceCandidate[])[0];
  if (!row) return { accepted: false, reason: "already_accepted" };

  await supabase.from("conversion_events").insert({
    agency_id: scope.agencyId,
    stage: "quotation_accepted",
    actor: "customer",
    lead_id: row.lead_id ?? candidate.lead_id ?? null,
    quotation_id: row.id,
    meta: { channel: "whatsapp", source: "in_chat_acceptance" },
  });
  await supabase.from("activity_log").insert({
    agency_id: scope.agencyId,
    actor: "ai",
    action: "Customer accepted the quotation in WhatsApp",
    entity: "quotation",
    entity_id: row.id,
    meta: { conversation_id: scope.conversationId },
  });

  return {
    accepted: true,
    reason: "accepted",
    quotation: {
      id: row.id,
      quotationNumber: row.quotation_number ?? candidate.quotation_number ?? null,
      totalMyr: num(row.total ?? candidate.total),
      depositMyr: num(row.deposit_amount ?? candidate.deposit_amount),
      leadId: row.lead_id ?? candidate.lead_id ?? null,
    },
  };
}
