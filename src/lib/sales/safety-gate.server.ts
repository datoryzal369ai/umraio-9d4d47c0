import type { SupabaseClient } from "@supabase/supabase-js";

import type { ConversationIntelligence } from "./conversation-intelligence.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * UMRAIO® Step 3.6 — DETERMINISTIC SAFETY GATE.
 *
 * Customer-control decisions are never delegated to a model. Opt-out and
 * explicit human requests are resolved in code, before any generation call,
 * and they suppress all autonomous outbound messaging.
 */

export type SafetyGateResult = {
  blocked: boolean;
  reason: "opt_out" | "human_requested" | null;
  /**
   * RELIABILITY: a blocked turn is still a TERMINAL OUTCOME the customer can
   * see. Silence is never an acceptable answer — the pipeline sends this single
   * closing acknowledgement, then stops.
   */
  customerMessage: string | null;
};

/** Final, non-promotional acknowledgement sent once when the AI stands down. */
export const OPT_OUT_ACK =
  "Baik, saya hentikan mesej automatik untuk nombor ini. Terima kasih dan maaf jika mengganggu. Jika perlukan bantuan pada bila-bila masa, hantar mesej semula ya.";
export const HUMAN_HANDOFF_ACK =
  "Baik, saya sambungkan kepada rakan sekerja kami. Mohon tunggu sebentar ya.";


async function cancelPendingFollowups(
  supabase: Db,
  agencyId: string,
  leadId: string,
  reason: string,
) {
  await supabase
    .from("followup_jobs")
    .update({ status: "skipped", skip_reason: reason })
    .eq("agency_id", agencyId)
    .eq("lead_id", leadId)
    .eq("status", "pending");
}

export async function applySafetyGate(args: {
  supabase: Db;
  agencyId: string;
  conversationId: string;
  leadId: string | null;
  intel: ConversationIntelligence;
}): Promise<SafetyGateResult> {
  const { supabase, agencyId, conversationId, leadId, intel } = args;
  const now = new Date().toISOString();

  // P0-1 — the compliant acknowledgement belongs to the STATE TRANSITION, not
  // to every muted turn. State is read from the existing conversations row.
  const { shouldSendSafetyAck } = await import("../whatsapp/duplicate-suppression.core");
  const { data: currentConversation } = await supabase
    .from("conversations")
    .select("conversation_state")
    .eq("id", conversationId)
    .maybeSingle();
  const currentState =
    (currentConversation as { conversation_state?: string | null } | null)?.conversation_state ??
    null;

  if (intel.optOut) {
    await supabase
      .from("conversations")
      .update({
        ai_enabled: false,
        // J4 — mark the mute boundary so messages received while muted are
        // never replayed if a human re-enables the AI later.
        ai_muted_at: now,
        human_attention_required: true,
        conversation_state: "DO_NOT_CONTACT",
        state_updated_at: now,
        escalated_at: now,
        escalation_reason: "Customer requested no further contact",
      })
      .eq("id", conversationId);

    if (leadId) {
      const { data: leadRow } = await supabase
        .from("leads")
        .select("stage")
        .eq("id", leadId)
        .eq("agency_id", agencyId)
        .maybeSingle();
      await supabase
        .from("leads")
        .update({
          do_not_contact: true,
          do_not_contact_at: now,
          do_not_contact_reason: intel.optOutPhrase ?? "Customer opted out",
          stage: "lost",
        })
        .eq("id", leadId);
      await cancelPendingFollowups(supabase, agencyId, leadId, "Customer opted out of contact");
      const { recordLeadStageTransition } = await import("../conversion/producers");
      await recordLeadStageTransition({
        db: supabase,
        agencyId,
        leadId,
        from: (leadRow?.stage as string | undefined) ?? null,
        to: "lost",
        actor: "customer",
        reason: "opt_out",
      });
    }

    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "ai",
      action: "Customer opted out — do-not-contact applied",
      entity: "lead",
      entity_id: leadId,
      meta: { conversation_id: conversationId, phrase: intel.optOutPhrase ?? null },
    });
    await supabase.from("notifications").insert({
      agency_id: agencyId,
      kind: "do_not_contact",
      severity: "warning",
      title: "Customer asked not to be contacted",
      body: "UMRAIO stopped all automated messages and follow-ups for this lead.",
      entity: "conversation",
      entity_id: conversationId,
      meta: { lead_id: leadId },
    });

    return {
      blocked: true,
      reason: "opt_out",
      customerMessage: shouldSendSafetyAck({ currentState, targetState: "DO_NOT_CONTACT" })
        ? OPT_OUT_ACK
        : null,
    };
  }

  if (intel.humanRequested) {
    await supabase
      .from("conversations")
      .update({
        ai_enabled: false,
        // J4 — mute boundary for no-replay on re-enable.
        ai_muted_at: now,
        human_attention_required: true,
        conversation_state: "HUMAN_HANDOFF",
        state_updated_at: now,
        escalated_at: now,
        escalation_reason: "Customer asked to speak to a human",
      })
      .eq("id", conversationId);

    if (leadId) {
      await cancelPendingFollowups(supabase, agencyId, leadId, "Human handover requested");
    }

    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "ai",
      action: "Customer requested a human — AI paused",
      entity: "conversation",
      entity_id: conversationId,
      meta: { lead_id: leadId },
    });
    await supabase.from("notifications").insert({
      agency_id: agencyId,
      kind: "human_handoff",
      severity: "critical",
      title: "Customer asked for a real person",
      body: "AI replies are paused on this conversation. Please take over now.",
      entity: "conversation",
      entity_id: conversationId,
      meta: { lead_id: leadId },
    });

    return { blocked: true, reason: "human_requested", customerMessage: HUMAN_HANDOFF_ACK };
  }

  return { blocked: false, reason: null, customerMessage: null };
}
