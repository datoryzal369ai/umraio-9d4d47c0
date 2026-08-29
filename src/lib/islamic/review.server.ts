import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsappText } from "../whatsapp-send.server";
import {
  ISLAMIC_AUDIT_EVENTS,
  islamicDedupeKey,
  isCurrentTurnIslamicReviewPending,
  isOpenIslamicReview,
  planPendingReviewReply,
  rejectionMessage,
  validateDecision,
  type IslamicReviewDecision,
  type IslamicReviewStatus,
} from "./review.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

const SELECT_COLUMNS =
  "id, agency_id, conversation_id, lead_id, question, topic, risk_level, escalation_reason, ai_draft_answer, ai_sources, status, reviewer_id, approved_answer, rejection_reason, amendment_notes, holding_sent_at, delivered_at, delivery_status, reference, created_at, decided_at";

export type IslamicReviewRow = {
  id: string;
  agency_id: string;
  conversation_id: string | null;
  lead_id: string | null;
  question: string;
  topic: string;
  risk_level?: string | null;
  escalation_reason?: string | null;
  ai_draft_answer?: string | null;
  ai_sources?: string | null;
  status: string;
  reviewer_id: string | null;
  approved_answer: string | null;
  rejection_reason: string | null;
  amendment_notes: string | null;
  holding_sent_at: string | null;
  delivered_at: string | null;
  delivery_status: string;
  reference: string | null;
  created_at: string;
  decided_at: string | null;
};

/** Audit through the EXISTING activity_log. IDs only — never customer PII. */
async function auditIslamic(
  supabase: Db,
  args: {
    agencyId: string;
    event: string;
    reviewId: string | null;
    actor?: string;
    actorUserId?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await supabase.from("activity_log").insert({
      agency_id: args.agencyId,
      actor: args.actor ?? "system",
      // Y-6B: human decisions carry the acting user; ai/system stay null.
      actor_user_id: args.actor === "human" ? (args.actorUserId ?? null) : null,
      action: args.event,
      entity: "islamic_review",
      entity_id: args.reviewId,
      meta: { layer: "islamic_implementation_layer", ...(args.meta ?? {}) },
    });
  } catch {
    /* audit must never break the workflow */
  }
  console.log(`[islamic] ${args.event} review=${args.reviewId ?? "none"}`);
}

/**
 * Create ONE Islamic review, or reuse the existing open review for the same
 * agency + conversation + question topic. Duplicate protection is enforced
 * both by the lookup and by the partial unique index in the database.
 */
export async function createOrReuseIslamicReview(
  supabase: Db,
  args: {
    agencyId: string;
    conversationId: string | null;
    leadId?: string | null;
    question: string;
    topic: string;
    riskLevel?: string;
    escalationReason?: string | null;
    draftAnswer?: string | null;
    sources?: string | null;
  },
): Promise<{ recorded: boolean; reviewId: string | null; deduplicated: boolean; reference: string | null }> {
  const dedupeKey = islamicDedupeKey(args.topic, args.question);

  const { data: existing } = await supabase
    .from("islamic_reviews")
    .select("id, reference, status")
    .eq("agency_id", args.agencyId)
    .eq("conversation_id", args.conversationId)
    .eq("dedupe_key", dedupeKey)
    .in("status", ["PENDING", "AMENDED"])
    .maybeSingle();

  if (existing?.id) {
    await auditIslamic(supabase, {
      agencyId: args.agencyId,
      event: ISLAMIC_AUDIT_EVENTS.deduplicated,
      reviewId: existing.id,
      meta: { conversation_id: args.conversationId, topic: args.topic },
    });
    return {
      recorded: true,
      reviewId: existing.id,
      deduplicated: true,
      reference: (existing.reference as string | null) ?? null,
    };
  }

  const reference = `IIL-${Date.now().toString(36).toUpperCase()}`;
  const { data: created, error } = await supabase
    .from("islamic_reviews")
    .insert({
      agency_id: args.agencyId,
      conversation_id: args.conversationId,
      lead_id: args.leadId ?? null,
      question: args.question.slice(0, 2000),
      topic: args.topic,
      dedupe_key: dedupeKey,
      risk_level: args.riskLevel ?? "HIGH_RISK",
      escalation_reason: args.escalationReason ?? null,
      ai_draft_answer: (args.draftAnswer ?? "").slice(0, 4000) || null,
      ai_sources: (args.sources ?? "").slice(0, 2000) || null,
      status: "PENDING",
      reference,
    })
    .select("id, reference")
    .maybeSingle();

  if (error || !created?.id) {
    // Unique-index race: another concurrent request won. Reuse its review.
    const { data: raced } = await supabase
      .from("islamic_reviews")
      .select("id, reference")
      .eq("agency_id", args.agencyId)
      .eq("conversation_id", args.conversationId)
      .eq("dedupe_key", dedupeKey)
      .in("status", ["PENDING", "AMENDED"])
      .maybeSingle();
    if (raced?.id) {
      await auditIslamic(supabase, {
        agencyId: args.agencyId,
        event: ISLAMIC_AUDIT_EVENTS.deduplicated,
        reviewId: raced.id,
        meta: { race: true },
      });
      return {
        recorded: true,
        reviewId: raced.id,
        deduplicated: true,
        reference: (raced.reference as string | null) ?? null,
      };
    }
    return { recorded: false, reviewId: null, deduplicated: false, reference: null };
  }

  await auditIslamic(supabase, {
    agencyId: args.agencyId,
    event: ISLAMIC_AUDIT_EVENTS.created,
    reviewId: created.id,
    meta: { conversation_id: args.conversationId, topic: args.topic },
  });

  // Backward compatibility: keep the existing notification, now referencing
  // the Islamic review ID. No ai_tasks row is ever created.
  try {
    await supabase.from("notifications").insert({
      agency_id: args.agencyId,
      kind: "religious_guidance_review",
      severity: "warning",
      title: `Religious guidance review needed (${args.topic})`,
      body: args.question.slice(0, 2000),
      entity: "islamic_review",
      entity_id: created.id,
      meta: {
        reference,
        islamic_review_id: created.id,
        requires_expert_review: true,
        review_status: "PENDING",
        layer: "islamic_implementation_layer",
        conversation_id: args.conversationId,
      },
    });
  } catch {
    /* notification is advisory only */
  }

  return { recorded: true, reviewId: created.id, deduplicated: false, reference };
}

/** The open review (if any) blocking normal AI generation for a conversation. */
export async function findOpenReviewForConversation(
  supabase: Db,
  conversationId: string,
): Promise<IslamicReviewRow | null> {
  const { data } = await supabase
    .from("islamic_reviews")
    .select(SELECT_COLUMNS)
    .eq("conversation_id", conversationId)
    .in("status", ["PENDING", "AMENDED"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as IslamicReviewRow | null) ?? null;
}

/**
 * Authoritative turn-scoped review lookup used by both the early loop breaker
 * and outbound voice eligibility. An older open review remains actionable for
 * reviewers, but is never returned as a blocker for this turn.
 */
export async function findCurrentTurnOpenReview(
  supabase: Db,
  conversationId: string,
  inboundAt: Date | string,
  currentQuestion: string,
  action = "reply_pipeline",
): Promise<IslamicReviewRow | null> {
  const inboundTimestamp = inboundAt instanceof Date ? inboundAt.toISOString() : inboundAt;
  const review = await findOpenReviewForConversation(supabase, conversationId);
  const currentTurnMatch = isCurrentTurnIslamicReviewPending(review, inboundAt, currentQuestion);
  const previousReview = Boolean(review) && !currentTurnMatch;
  console.log(
    `[islamic] ISLAMIC_REVIEW_LOOKUP conversation_id=${conversationId} current_inbound_timestamp=${inboundTimestamp} review_id=${review?.id ?? "none"} review_created_at=${review?.created_at ?? "none"} review_status=${review?.status ?? "none"} current_turn_match=${currentTurnMatch}`,
  );
  console.log(
    `[islamic] ISLAMIC_REVIEW_RESULT conversation_id=${conversationId} previous_review=${previousReview} current_turn_match=${currentTurnMatch} action=${currentTurnMatch ? action : "continue_current_turn"}`,
  );
  return currentTurnMatch ? review : null;
}

export { planPendingReviewReply, isOpenIslamicReview };

export async function markHoldingSent(supabase: Db, reviewId: string): Promise<void> {
  await supabase
    .from("islamic_reviews")
    .update({ holding_sent_at: new Date().toISOString() })
    .eq("id", reviewId)
    .is("holding_sent_at", null);
}

/** Resolve the outbound WhatsApp destination for a review's conversation. */
async function resolveDelivery(
  supabase: Db,
  review: IslamicReviewRow,
): Promise<{ to: string; phoneNumberId: string; accessToken: string } | null> {
  if (!review.conversation_id) return null;
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, external_id, lead_id")
    .eq("id", review.conversation_id)
    .maybeSingle();
  let to = (conversation?.external_id as string | null) ?? null;
  if (!to && (review.lead_id || conversation?.lead_id)) {
    const { data: lead } = await supabase
      .from("leads")
      .select("phone")
      .eq("id", review.lead_id ?? conversation?.lead_id)
      .maybeSingle();
    to = (lead?.phone as string | null) ?? null;
  }
  if (!to) return null;
  const { data: config } = await supabase
    .from("whatsapp_configs")
    .select("phone_number_id, access_token")
    .eq("agency_id", review.agency_id)
    .maybeSingle();
  if (!config?.phone_number_id || !config?.access_token) return null;
  return { to, phoneNumberId: config.phone_number_id, accessToken: config.access_token };
}

/**
 * Deliver a decided review's customer-facing text EXACTLY ONCE.
 *
 * The approved answer is sent verbatim — it never re-enters AI generation and
 * never triggers another clarification cycle. Text only for V1.
 */
export async function deliverIslamicOutcome(
  supabase: Db,
  reviewId: string,
): Promise<{ delivered: boolean; reason?: string }> {
  const { data: review } = await supabase
    .from("islamic_reviews")
    .select(SELECT_COLUMNS)
    .eq("id", reviewId)
    .maybeSingle();
  const row = review as IslamicReviewRow | null;
  if (!row) return { delivered: false, reason: "not_found" };
  if (row.status !== "APPROVED" && row.status !== "REJECTED")
    return { delivered: false, reason: "not_decided" };
  if (row.delivered_at) return { delivered: false, reason: "already_delivered" };

  const body =
    row.status === "APPROVED" ? (row.approved_answer ?? "").trim() : rejectionMessage();
  if (!body) return { delivered: false, reason: "empty_answer" };

  // Idempotency claim: only one caller may transition to a delivery attempt.
  const { data: claimed } = await supabase
    .from("islamic_reviews")
    .update({ delivered_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("delivered_at", null)
    .select("id");
  if (!claimed || claimed.length === 0) return { delivered: false, reason: "already_delivered" };

  await auditIslamic(supabase, {
    agencyId: row.agency_id,
    event: ISLAMIC_AUDIT_EVENTS.deliveryStarted,
    reviewId: row.id,
  });

  const target = await resolveDelivery(supabase, row);
  if (!target) {
    await supabase
      .from("islamic_reviews")
      .update({ delivery_status: "failed" })
      .eq("id", row.id);
    await auditIslamic(supabase, {
      agencyId: row.agency_id,
      event: ISLAMIC_AUDIT_EVENTS.deliveryFailed,
      reviewId: row.id,
      meta: { reason: "no_delivery_target" },
    });
    return { delivered: false, reason: "no_delivery_target" };
  }

  const sent = await sendWhatsappText(target.phoneNumberId, target.accessToken, target.to, body);

  if (row.conversation_id) {
    await supabase.from("messages").insert({
      agency_id: row.agency_id,
      conversation_id: row.conversation_id,
      sender: "human",
      body,
      modality: "text",
    });
    await supabase
      .from("conversations")
      .update({ last_message_at: new Date().toISOString(), human_attention_required: false })
      .eq("id", row.conversation_id);
  }

  await supabase
    .from("islamic_reviews")
    .update({ delivery_status: sent ? "sent" : "failed" })
    .eq("id", row.id);

  await auditIslamic(supabase, {
    agencyId: row.agency_id,
    event: sent
      ? ISLAMIC_AUDIT_EVENTS.deliverySucceeded
      : ISLAMIC_AUDIT_EVENTS.deliveryFailed,
    reviewId: row.id,
    meta: { status: row.status },
  });

  return { delivered: sent, ...(sent ? {} : { reason: "send_failed" }) };
}

/**
 * Server-authoritative decision. Status, reviewer and agency are resolved
 * here; nothing from the client is trusted.
 */
export async function applyIslamicDecision(
  supabase: Db,
  args: {
    agencyId: string;
    reviewerId: string;
    reviewId: string;
    decision: IslamicReviewDecision;
    approvedAnswer?: string | null;
    amendmentNotes?: string | null;
    rejectionReason?: string | null;
  },
): Promise<{ status: IslamicReviewStatus; delivered: boolean }> {
  const { data: review } = await supabase
    .from("islamic_reviews")
    .select(SELECT_COLUMNS)
    .eq("id", args.reviewId)
    .maybeSingle();
  const row = review as IslamicReviewRow | null;
  if (!row) throw new Error("Islamic review not found");
  if (row.agency_id !== args.agencyId) throw new Error("Islamic review not found");

  const validation = validateDecision({
    currentStatus: row.status,
    decision: args.decision,
    approvedAnswer: args.approvedAnswer ?? null,
    amendmentNotes: args.amendmentNotes ?? null,
    rejectionReason: args.rejectionReason ?? null,
  });
  if (!validation.ok) throw new Error(validation.reason);
  const nextStatus = validation.nextStatus;

  const patch: Record<string, unknown> = {
    status: nextStatus,
    reviewer_id: args.reviewerId,
    decided_at: new Date().toISOString(),
  };
  if (args.decision === "approve") patch["approved_answer"] = (args.approvedAnswer ?? "").trim();
  if (args.decision === "amend") {
    patch["amendment_notes"] = (args.amendmentNotes ?? "").trim();
    // An amended answer becomes the candidate answer, but is NOT delivered
    // until the approver explicitly confirms AMENDED → APPROVED.
    patch["approved_answer"] = (args.amendmentNotes ?? "").trim();
  }
  if (args.decision === "reject") patch["rejection_reason"] = (args.rejectionReason ?? "").trim();

  // Compare-and-set: two concurrent decisions cannot both apply.
  const { data: claimed } = await supabase
    .from("islamic_reviews")
    .update(patch)
    .eq("id", row.id)
    .eq("status", row.status)
    .select("id");
  if (!claimed || claimed.length === 0)
    throw new Error("This review was already decided by someone else.");

  await auditIslamic(supabase, {
    agencyId: args.agencyId,
    actor: "human",
    actorUserId: args.reviewerId,
    event:
      nextStatus === "APPROVED"
        ? ISLAMIC_AUDIT_EVENTS.approved
        : nextStatus === "AMENDED"
          ? ISLAMIC_AUDIT_EVENTS.amended
          : ISLAMIC_AUDIT_EVENTS.rejected,
    reviewId: row.id,
    meta: { reviewer_id: args.reviewerId, from: row.status, to: nextStatus },
  });

  let delivered = false;
  if (nextStatus === "APPROVED" || nextStatus === "REJECTED") {
    const outcome = await deliverIslamicOutcome(supabase, row.id);
    delivered = outcome.delivered;
  } else {
    await supabase
      .from("islamic_reviews")
      .update({ delivery_status: "not_started" })
      .eq("id", row.id);
  }

  return { status: nextStatus, delivered };
}
