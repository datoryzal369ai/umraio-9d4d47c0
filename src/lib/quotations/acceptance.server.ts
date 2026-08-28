/**
 * RED-1 — WhatsApp in-chat quotation acceptance.
 *
 * Finds the quotation an explicit "SETUJU" refers to, using the tenant + lead
 * relationship (conversation_id is used when present but never required), and
 * moves it to `accepted` exactly once. No new quotation is ever created and no
 * pricing/package fact is ever rewritten.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ExistingQuotationCard } from "@/lib/sales/whatsapp-presentation.core";

import {
  ACCEPTABLE_QUOTATION_STATUSES,
  selectAcceptanceCandidate,
  type AcceptanceCandidate,
} from "./closing.core";
import {
  detectRequestedPackage,
  packageIdentityMatches,
  type PackageIdentity,
} from "./package-identity.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type AcceptQuotationResult = {
  accepted: boolean;
  reason: "accepted" | "no_scope" | "no_candidate" | "already_accepted" | "package_mismatch";
  quotation?: {
    id: string;
    quotationNumber: string | null;
    totalMyr: number | null;
    depositMyr: number | null;
    leadId: string | null;
  };
  /** RED-3 — set only on `package_mismatch`, for the deterministic reply. */
  mismatch?: { requested: PackageIdentity; card: ExistingQuotationCard };
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function acceptQuotationInChat(
  supabase: Db,
  scope: {
    agencyId: string;
    leadId: string | null;
    conversationId: string | null;
    /** RED-3 — recent customer messages (oldest→newest) for identity detection. */
    customerMessages?: ReadonlyArray<string | null | undefined>;
    /** RED-3 — agency catalogue package names, so catalogue names win over tiers. */
    catalogueNames?: ReadonlyArray<string | null | undefined>;
  },
): Promise<AcceptQuotationResult> {
  if (!scope.leadId && !scope.conversationId) return { accepted: false, reason: "no_scope" };

  const orParts: string[] = [];
  if (scope.leadId) orParts.push(`lead_id.eq.${scope.leadId}`);
  if (scope.conversationId) orParts.push(`conversation_id.eq.${scope.conversationId}`);

  const { data: rows } = await supabase
    .from("quotations")
    .select(
      "id, agency_id, lead_id, conversation_id, status, quotation_number, total, deposit_amount, number_of_pilgrims, package_snapshot",
    )
    .eq("agency_id", scope.agencyId)
    .or(orParts.join(","))
    .order("created_at", { ascending: false })
    .limit(10);

  const allRows = (rows ?? []) as AcceptanceCandidate[];
  const candidate = selectAcceptanceCandidate(allRows, scope);

  // RED-3 — never accept package A when the customer explicitly asked for
  // package B. Read-only comparison, reusing the RED-2 identity logic.
  const requested = detectRequestedPackage(
    scope.customerMessages ?? [],
    scope.catalogueNames ?? [],
  );

  const mismatchFor = (row: AcceptanceCandidate): AcceptQuotationResult | null => {
    if (!requested) return null;
    const raw = row as AcceptanceCandidate & {
      package_snapshot?: Record<string, unknown> | null;
      number_of_pilgrims?: number | string | null;
    };
    const packageName =
      typeof raw.package_snapshot?.["name"] === "string"
        ? (raw.package_snapshot["name"] as string)
        : null;
    if (packageIdentityMatches(requested, packageName)) return null;
    return {
      accepted: false,
      reason: "package_mismatch",
      mismatch: {
        requested,
        card: {
          quotationNumber: row.quotation_number ?? null,
          packageName,
          totalMyr: num(row.total),
          depositMyr: num(row.deposit_amount),
          pax: num(raw.number_of_pilgrims),
        },
      },
    };
  };

  if (!candidate) {
    // No live candidate (e.g. the only quotation is already `accepted`).
    // A sticky explicit package preference must still never be answered with
    // an acceptance confirmation — reuse the deterministic mismatch reply.
    const scoped = allRows.filter((r) => {
      if (!r?.id) return false;
      if (r.agency_id && r.agency_id !== scope.agencyId) return false;
      const sameConversation = Boolean(
        scope.conversationId && r.conversation_id === scope.conversationId,
      );
      const sameLead = Boolean(scope.leadId && r.lead_id === scope.leadId);
      return sameConversation || sameLead;
    });
    for (const row of scoped) {
      const mismatch = mismatchFor(row);
      if (mismatch) return mismatch;
      break;
    }
    return { accepted: false, reason: "no_candidate" };
  }

  const liveMismatch = mismatchFor(candidate);
  if (liveMismatch) return liveMismatch;



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
