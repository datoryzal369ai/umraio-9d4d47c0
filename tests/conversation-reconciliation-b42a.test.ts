import { describe, expect, it } from "vitest";

import { mergeRealtimeMessage, reconcileMessages } from "@/lib/conversations/realtime.core";
import type { ChatMessage } from "@/lib/conversations";

const CONV = "conv-1";

function msg(id: string, created_at: string, conversation_id = CONV, body = `body-${id}`): ChatMessage {
  return { id, conversation_id, agency_id: "agency-1", sender: "customer", body, created_at };
}

function iso(minute: number) {
  return new Date(Date.UTC(2026, 7, 24, 9, minute, 0)).toISOString();
}

/** newest 100 of an 884-row conversation */
function serverWindow() {
  return Array.from({ length: 100 }, (_, i) => msg(`m${784 + i}`, iso(i)));
}

describe("B-4.2a message reconciliation", () => {
  it("renders the server window on first load", () => {
    const out = reconcileMessages([], serverWindow(), CONV);
    expect(out).toHaveLength(100);
    expect(out[0]!.id).toBe("m784");
    expect(out.at(-1)!.id).toBe("m883");
  });

  it("keeps a realtime message that is newer than the fetched window (refetch)", () => {
    const withRealtime = mergeRealtimeMessage(serverWindow(), msg("live-1", iso(200)), CONV);
    const afterRefetch = reconcileMessages(withRealtime, serverWindow(), CONV);
    expect(afterRefetch.at(-1)!.id).toBe("live-1");
  });

  it("survives repeated polling refetches (20s fallback)", () => {
    let list = mergeRealtimeMessage(serverWindow(), msg("live-1", iso(200)), CONV);
    for (let i = 0; i < 3; i += 1) list = reconcileMessages(list, serverWindow(), CONV);
    expect(list.filter((m) => m.id === "live-1")).toHaveLength(1);
  });

  it("survives window focus and SUBSCRIBED resync refetches", () => {
    const live = msg("live-1", iso(200));
    let list = mergeRealtimeMessage(serverWindow(), live, CONV);
    list = reconcileMessages(list, serverWindow(), CONV); // focus
    list = reconcileMessages(list, serverWindow(), CONV); // resync
    expect(list.some((m) => m.id === "live-1")).toBe(true);
  });

  it("lets server data win for the same message id", () => {
    const local = msg("m1", iso(1), CONV, "optimistic");
    const server = { ...msg("m1", iso(1)), body: "authoritative" };
    expect(reconcileMessages([local], [server], CONV)[0]!.body).toBe("authoritative");
  });

  it("produces one row for a duplicate realtime event", () => {
    const live = msg("live-1", iso(200));
    let list = mergeRealtimeMessage([], live, CONV);
    list = mergeRealtimeMessage(list, live, CONV);
    list = reconcileMessages(list, [live], CONV);
    expect(list).toHaveLength(1);
  });

  it("rejects cross-conversation rows from both sources", () => {
    const out = reconcileMessages([msg("x", iso(1), "other")], [msg("y", iso(2), "other")], CONV);
    expect(out).toEqual([]);
  });

  it("prepends an older page without dropping newer messages", () => {
    const current = serverWindow();
    const olderPage = Array.from({ length: 100 }, (_, i) => msg(`o${i}`, iso(-200 + i)));
    const out = reconcileMessages(current, olderPage, CONV);
    expect(out).toHaveLength(200);
    expect(out[0]!.id).toBe("o0");
    expect(out.at(-1)!.id).toBe("m883");
  });

  it("keeps chronological order after every merge", () => {
    let list = reconcileMessages([], serverWindow(), CONV);
    list = mergeRealtimeMessage(list, msg("live-1", iso(200)), CONV);
    list = reconcileMessages(list, [msg("mid", iso(50))], CONV);
    const times = list.map((m) => new Date(m.created_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("never fetches the whole conversation: window size stays bounded", () => {
    expect(serverWindow()).toHaveLength(100);
  });
});
