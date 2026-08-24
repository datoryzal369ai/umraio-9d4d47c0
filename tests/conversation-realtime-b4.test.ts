import { describe, expect, it, vi } from "vitest";

import {
  mergeRealtimeMessage,
  subscribeToConversation,
  type MinimalRealtimeClient,
} from "@/lib/conversations/realtime.core";
import type { ChatMessage } from "@/lib/conversations";

const CONV = "conv-1";

function msg(id: string, sender: ChatMessage["sender"], created_at: string, conversation_id = CONV): ChatMessage {
  return { id, conversation_id, agency_id: "agency-1", sender, body: `body-${id}`, created_at };
}

function fakeClient() {
  const handlers: Array<{ filter: Record<string, unknown>; cb: (p: { new: unknown }) => void }> = [];
  const removed: string[] = [];
  let statusCb: ((s: never) => void) | undefined;
  const channel = {
    on(_event: string, filter: Record<string, unknown>, cb: (p: { new: unknown }) => void) {
      handlers.push({ filter, cb });
      return channel;
    },
    subscribe(cb?: (s: never) => void) {
      statusCb = cb;
      return channel;
    },
  };
  const client: MinimalRealtimeClient = {
    channel: (name: string) => {
      removed.push(`open:${name}`);
      return channel as never;
    },
    removeChannel: () => removed.push("removed"),
  };
  return {
    client,
    handlers,
    removed,
    emit(table: string, event: string, row: unknown) {
      for (const h of handlers) {
        if (h.filter["table"] === table && h.filter["event"] === event) h.cb({ new: row });
      }
    },
    status: (s: string) => statusCb?.(s as never),
  };
}

describe("B-4 realtime message merge", () => {
  it("adds a realtime customer message automatically", () => {
    const out = mergeRealtimeMessage([], msg("m1", "customer", "2026-08-24T10:00:00Z"), CONV);
    expect(out.map((m) => m.id)).toEqual(["m1"]);
  });

  it("adds a realtime AI message automatically", () => {
    const out = mergeRealtimeMessage(
      [msg("m1", "customer", "2026-08-24T10:00:00Z")],
      msg("m2", "ai", "2026-08-24T10:00:05Z"),
      CONV,
    );
    expect(out.map((m) => m.sender)).toEqual(["customer", "ai"]);
  });

  it("adds a realtime human message automatically", () => {
    const out = mergeRealtimeMessage([], msg("m3", "human", "2026-08-24T10:00:09Z"), CONV);
    expect(out[0]!.sender).toBe("human");
  });

  it("does not duplicate a repeated INSERT event (dedupe by id)", () => {
    const first = mergeRealtimeMessage([], msg("m1", "customer", "2026-08-24T10:00:00Z"), CONV);
    const second = mergeRealtimeMessage(first, msg("m1", "customer", "2026-08-24T10:00:00Z"), CONV);
    expect(second).toHaveLength(1);
  });

  it("does not duplicate identical bodies with different ids", () => {
    const a = msg("m1", "customer", "2026-08-24T10:00:00Z");
    const b = { ...msg("m2", "customer", "2026-08-24T10:00:01Z"), body: a.body };
    expect(mergeRealtimeMessage([a], b, CONV)).toHaveLength(2);
  });

  it("rejects messages from another conversation", () => {
    const out = mergeRealtimeMessage([], msg("x1", "customer", "2026-08-24T10:00:00Z", "other-conv"), CONV);
    expect(out).toEqual([]);
  });

  it("preserves chronological order regardless of arrival order", () => {
    let list: ChatMessage[] = [];
    list = mergeRealtimeMessage(list, msg("m2", "ai", "2026-08-24T10:00:05Z"), CONV);
    list = mergeRealtimeMessage(list, msg("m1", "customer", "2026-08-24T10:00:00Z"), CONV);
    expect(list.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("refetch after reconnect does not duplicate realtime rows", () => {
    const realtime = msg("m1", "customer", "2026-08-24T10:00:00Z");
    let list = mergeRealtimeMessage([], realtime, CONV);
    // simulated refetch result merged back in
    for (const row of [realtime, msg("m2", "ai", "2026-08-24T10:00:02Z")]) {
      list = mergeRealtimeMessage(list, row, CONV);
    }
    expect(list.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("B-4 realtime channel lifecycle", () => {
  it("scopes every subscription filter to the open conversation", () => {
    const f = fakeClient();
    subscribeToConversation(f.client, { conversationId: CONV, onMessage: () => {} });
    expect(f.handlers.length).toBeGreaterThan(0);
    for (const h of f.handlers) {
      const filter = String(h.filter["filter"]);
      expect(filter.includes(CONV)).toBe(true);
      expect(filter.startsWith("conversation_id=eq.") || filter.startsWith("id=eq.")).toBe(true);
    }
  });

  it("ignores payloads for another conversation even if delivered", () => {
    const f = fakeClient();
    const onMessage = vi.fn();
    subscribeToConversation(f.client, { conversationId: CONV, onMessage });
    f.emit("messages", "INSERT", msg("x", "customer", "2026-08-24T10:00:00Z", "other-conv"));
    expect(onMessage).not.toHaveBeenCalled();
    f.emit("messages", "INSERT", msg("m1", "customer", "2026-08-24T10:00:00Z"));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("notifies conversation header changes for this conversation only", () => {
    const f = fakeClient();
    const onConversation = vi.fn();
    subscribeToConversation(f.client, { conversationId: CONV, onMessage: () => {}, onConversation });
    f.emit("conversations", "UPDATE", { id: "other", ai_enabled: false });
    f.emit("conversations", "UPDATE", { id: CONV, ai_enabled: true });
    expect(onConversation).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount and is idempotent (no leaks/duplicates)", () => {
    const f = fakeClient();
    const unsubscribe = subscribeToConversation(f.client, { conversationId: CONV, onMessage: () => {} });
    unsubscribe();
    unsubscribe();
    expect(f.removed.filter((r) => r === "removed")).toHaveLength(1);
  });

  it("reports channel status for reconnect-driven resync", () => {
    const f = fakeClient();
    const onStatus = vi.fn();
    subscribeToConversation(f.client, { conversationId: CONV, onMessage: () => {}, onStatus });
    f.status("SUBSCRIBED");
    f.status("CHANNEL_ERROR");
    expect(onStatus).toHaveBeenCalledWith("SUBSCRIBED");
    expect(onStatus).toHaveBeenCalledWith("CHANNEL_ERROR");
  });
});
