/**
 * B-4 — REAL-TIME WHATSAPP CONVERSATION SYNC (pure core).
 *
 * Contains only synchronisation logic: message merging/deduplication and the
 * realtime channel factory. No AI, sales, voice or billing behaviour lives here.
 */
import type { ChatMessage, Conversation } from "@/lib/conversations";

/**
 * Merge a realtime/refetched message into the visible list.
 *
 * - Deduplicates strictly by `message.id` (never by body).
 * - Drops rows belonging to another conversation (defence in depth on top of
 *   the server-side realtime filter and RLS).
 * - Preserves chronological ordering by `created_at`, then `id` for stability.
 */
export function mergeRealtimeMessage(
  current: ChatMessage[],
  incoming: ChatMessage,
  conversationId: string,
): ChatMessage[] {
  if (!incoming?.id) return current;
  if (incoming.conversation_id !== conversationId) return current;

  const index = current.findIndex((m) => m.id === incoming.id);
  const next = index >= 0 ? current.map((m) => (m.id === incoming.id ? { ...m, ...incoming } : m)) : [...current, incoming];

  return next.sort((a, b) => {
    const delta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

export type RealtimeStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

type MinimalChannel = {
  on: (event: string, filter: Record<string, unknown>, cb: (payload: { new: unknown }) => void) => MinimalChannel;
  subscribe: (cb?: (status: RealtimeStatus) => void) => MinimalChannel;
};

export type MinimalRealtimeClient = {
  channel: (name: string) => MinimalChannel;
  removeChannel: (channel: MinimalChannel) => unknown;
};

/**
 * Subscribe to a SINGLE conversation. Scoped to `conversation_id` (RLS still
 * enforces agency isolation server-side), so no cross-conversation or
 * cross-tenant rows can ever reach this channel.
 *
 * Returns an unsubscribe function — always call it on unmount.
 */
export function subscribeToConversation(
  client: MinimalRealtimeClient,
  options: {
    conversationId: string;
    onMessage: (message: ChatMessage) => void;
    onConversation?: (conversation: Partial<Conversation>) => void;
    onStatus?: (status: RealtimeStatus) => void;
  },
): () => void {
  const { conversationId, onMessage, onConversation, onStatus } = options;

  const channel = client.channel(`conversation:${conversationId}`);

  channel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `conversation_id=eq.${conversationId}`,
    },
    (payload) => {
      const row = payload.new as ChatMessage | null;
      if (row?.id && row.conversation_id === conversationId) onMessage(row);
    },
  );

  channel.on(
    "postgres_changes",
    {
      event: "UPDATE",
      schema: "public",
      table: "messages",
      filter: `conversation_id=eq.${conversationId}`,
    },
    (payload) => {
      const row = payload.new as ChatMessage | null;
      if (row?.id && row.conversation_id === conversationId) onMessage(row);
    },
  );

  channel.on(
    "postgres_changes",
    {
      event: "UPDATE",
      schema: "public",
      table: "conversations",
      filter: `id=eq.${conversationId}`,
    },
    (payload) => {
      const row = payload.new as Partial<Conversation> | null;
      if (row?.id === conversationId) onConversation?.(row);
    },
  );

  channel.subscribe((status) => onStatus?.(status));

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    client.removeChannel(channel);
  };
}

/**
 * B-4.2a — RECONCILIATION (refetch) vs PATCH (realtime).
 *
 * The database is the source of truth for every row it returns, but the server
 * window is only the newest N messages. A refetch must therefore MERGE, never
 * replace: locally held rows outside the window (older pages, or realtime rows
 * that arrived after the window was computed) must survive.
 *
 * Rules:
 *  - union by message id,
 *  - server row wins when the same id exists on both sides,
 *  - foreign-conversation rows are rejected (defence in depth on top of RLS),
 *  - chronological ordering is preserved.
 */
export function reconcileMessages(
  current: ChatMessage[],
  serverWindow: ChatMessage[],
  conversationId: string,
): ChatMessage[] {
  let next = current.filter((m) => m.conversation_id === conversationId);
  for (const row of serverWindow) {
    next = mergeRealtimeMessage(next, row, conversationId);
  }
  return next;
}
