/**
 * J3 / J4 — RAPID MESSAGE COALESCING (pure logic).
 *
 * Rapid inbound WhatsApp messages ("Heloo", "Awak ada?") must produce ONE
 * contextual RAIŌ reply, never one LLM call per message. This module holds the
 * deterministic decisions; the DB claim/lock lives in `coalescing.server.ts`.
 *
 * Nothing here touches C1 (cron auth) or C2 (provider_message_id idempotency).
 */

/**
 * Time RAIŌ waits for additional rapid messages before answering.
 *
 * COMMERCIAL READINESS: tuned down from 9s so a normal conversational turn
 * lands in the 2.5–4s human range while still coalescing a rapid burst.
 */
export const COALESCE_WINDOW_MS = 4_000;

/**
 * VOICE V1 — audio-originated turns already spent time in media retrieval and
 * ASR, so they wait a shorter window. Text behaviour is unchanged.
 */
export const AUDIO_COALESCE_WINDOW_MS = 3_500;

/** A claim is considered abandoned after this long (crashed worker safety net). */
export const CLAIM_STALE_MS = 120_000;

export type CoalescedMessage = {
  agency_id: string;
  conversation_id: string;
  sender: string;
  body: string;
  created_at: string;
};

export function replyDueAt(now: Date, windowMs: number = COALESCE_WINDOW_MS): Date {
  return new Date(now.getTime() + windowMs);
}

export function isClaimStale(claimedAt: string | null | undefined, now: Date): boolean {
  if (!claimedAt) return true;
  const ts = Date.parse(claimedAt);
  if (Number.isNaN(ts)) return true;
  return now.getTime() - ts >= CLAIM_STALE_MS;
}

/**
 * The inbound messages a single coalesced reply must answer.
 *
 * - scoped strictly to one agency AND one conversation (never merged across
 *   tenants or conversations),
 * - only customer messages after the last AI/human turn,
 * - J4: anything that arrived while the AI was muted is excluded, so
 *   re-enabling RAIŌ never replays historical messages.
 */
export function selectCoalescedInbound(
  messages: CoalescedMessage[],
  scope: { agencyId: string; conversationId: string; mutedAt?: string | null },
): CoalescedMessage[] {
  const scoped = messages
    .filter((m) => m.agency_id === scope.agencyId && m.conversation_id === scope.conversationId)
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const pending: CoalescedMessage[] = [];
  for (const m of scoped) {
    if (m.sender === "customer") pending.push(m);
    else pending.length = 0; // an AI/human turn closes the previous batch
  }

  const mutedTs = scope.mutedAt ? Date.parse(scope.mutedAt) : NaN;
  if (!Number.isNaN(mutedTs)) {
    return pending.filter((m) => Date.parse(m.created_at) > mutedTs);
  }
  return pending;
}

/** True when there is genuine, non-replayed work for RAIŌ to answer. */
export function shouldGenerateReply(
  messages: CoalescedMessage[],
  scope: { agencyId: string; conversationId: string; mutedAt?: string | null },
): boolean {
  return selectCoalescedInbound(messages, scope).length > 0;
}
