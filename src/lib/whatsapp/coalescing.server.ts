import {
  AUDIO_COALESCE_WINDOW_MS,
  CLAIM_STALE_MS,
  COALESCE_WINDOW_MS,
  isClaimStale,
  replyDueAt,
  selectCoalescedInbound,
  type CoalescedMessage,
} from "./coalescing.core";

type Db = {
  from: (table: string) => any;
};

/**
 * Atomically claims the right to answer one conversation. Concurrent webhook
 * deliveries for the same conversation resolve to exactly one claim, so RAIŌ
 * can never produce duplicate outbound replies.
 *
 * Compare-and-set: the update only lands when the row is unclaimed or the
 * previous claim is stale (crashed worker).
 */
export async function claimConversationReply(
  supabase: Db,
  args: { agencyId: string; conversationId: string; now?: Date; windowMs?: number },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();

  const { data } = await supabase
    .from("conversations")
    .update({
      ai_reply_claimed_at: now.toISOString(),
      ai_reply_due_at: replyDueAt(now, args.windowMs ?? coalesceWindowMs()).toISOString(),
    })
    .eq("id", args.conversationId)
    .eq("agency_id", args.agencyId)
    .or(`ai_reply_claimed_at.is.null,ai_reply_claimed_at.lt.${staleBefore}`)
    .select("id");

  return Array.isArray(data) && data.length > 0;
}

/** Releases the claim so the next inbound burst can be answered. */
export async function releaseConversationClaim(
  supabase: Db,
  args: { agencyId: string; conversationId: string },
): Promise<void> {
  await supabase
    .from("conversations")
    .update({ ai_reply_claimed_at: null, ai_reply_due_at: null })
    .eq("id", args.conversationId)
    .eq("agency_id", args.agencyId);
}

/**
 * J4 — records the moment the AI was muted for this conversation. Messages that
 * arrive while muted are stored for the human, but never replayed to the model
 * once the AI is re-enabled.
 */
export async function markConversationMuted(
  supabase: Db,
  args: { agencyId: string; conversationId: string; at?: Date },
): Promise<void> {
  await supabase
    .from("conversations")
    .update({ ai_muted_at: (args.at ?? new Date()).toISOString() })
    .eq("id", args.conversationId)
    .eq("agency_id", args.agencyId);
}

/** Loads the recent turns of ONE conversation for coalescing decisions. */
export async function loadPendingInbound(
  supabase: Db,
  args: { agencyId: string; conversationId: string; mutedAt?: string | null },
): Promise<CoalescedMessage[]> {
  const { data } = await supabase
    .from("messages")
    .select("agency_id, conversation_id, sender, body, created_at")
    .eq("agency_id", args.agencyId)
    .eq("conversation_id", args.conversationId)
    .order("created_at", { ascending: false })
    .limit(40);

  const rows = (data ?? []) as CoalescedMessage[];
  return selectCoalescedInbound(rows, {
    agencyId: args.agencyId,
    conversationId: args.conversationId,
    mutedAt: args.mutedAt ?? null,
  });
}

/** Effective window; overridable server-side (tests / ops tuning). */
export function coalesceWindowMs(modality: "text" | "audio" = "text"): number {
  const raw = Number(process.env["WHATSAPP_COALESCE_WINDOW_MS"]);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return modality === "audio" ? AUDIO_COALESCE_WINDOW_MS : COALESCE_WINDOW_MS;
}

/** Waits out the coalescing window without blocking anything else. */
export function waitForCoalesceWindow(windowMs: number = coalesceWindowMs()): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, windowMs));
}

export { AUDIO_COALESCE_WINDOW_MS, COALESCE_WINDOW_MS, isClaimStale };
