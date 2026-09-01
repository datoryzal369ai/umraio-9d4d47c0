import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  CALL_ANSWER_DELAY_MS,
  extractCallEvents,
  parseCallEvent,
  resolveMediaCapability,
  shouldApplyCallStatus,
} from "../src/lib/calls/call-events.core";
import { processCallEvent } from "../src/lib/calls/calls.server";

function makeDb(opts: { agencyId?: string | null; existing?: { id: string; status: string } | null }) {
  const inserts: any[] = [];
  const updates: any[] = [];
  const db = {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        insert: (row: any) => {
          inserts.push({ table, row });
          return chain;
        },
        update: (row: any) => {
          updates.push({ table, row });
          return chain;
        },
        maybeSingle: async () => {
          if (table === "whatsapp_configs") return { data: opts.agencyId ? { agency_id: opts.agencyId } : null };
          return { data: opts.existing ?? null };
        },
      };
      return chain;
    },
  };
  return { db, inserts, updates };
}

const CONNECT = {
  id: "wacid.CALL1",
  from: "60123456789",
  to: "60111063 9996",
  event: "connect",
  direction: "USER_INITIATED",
  timestamp: "1756000000",
  session: { sdp_type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n" },
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("call event parsing", () => {
  it("parses a real Meta connect event including the supplied SDP", () => {
    const parsed = parseCallEvent(CONNECT)!;
    expect(parsed.callId).toBe("wacid.CALL1");
    expect(parsed.status).toBe("ringing");
    expect(parsed.direction).toBe("inbound");
    expect(parsed.sdp?.sdp).toContain("v=0");
  });

  it("never invents an SDP when Meta did not send one", () => {
    expect(parseCallEvent({ ...CONNECT, session: undefined })!.sdp).toBeNull();
  });

  it("maps terminate events to missed/terminated/failed", () => {
    expect(parseCallEvent({ ...CONNECT, event: "terminate" })!.status).toBe("missed");
    expect(parseCallEvent({ ...CONNECT, event: "terminate", status: "COMPLETED" })!.status).toBe("terminated");
    expect(parseCallEvent({ ...CONNECT, event: "terminate", status: "FAILED" })!.status).toBe("failed");
  });

  it("ignores unusable events", () => {
    expect(parseCallEvent({ event: "connect" })).toBeNull();
    expect(parseCallEvent({ ...CONNECT, event: "something_else" })).toBeNull();
    expect(extractCallEvents([CONNECT, { id: "x" }]).length).toBe(1);
  });
});

describe("call state machine", () => {
  it("is monotonic and never un-terminates a call", () => {
    expect(shouldApplyCallStatus(null, "ringing")).toBe(true);
    expect(shouldApplyCallStatus("ringing", "missed")).toBe(true);
    expect(shouldApplyCallStatus("missed", "ringing")).toBe(false);
    expect(shouldApplyCallStatus("terminated", "answered")).toBe(false);
    expect(shouldApplyCallStatus("answered", "ringing")).toBe(false);
    expect(shouldApplyCallStatus("ringing", "ringing")).toBe(false);
  });
});

describe("media capability boundary", () => {
  it("reports media_gateway_required when no gateway is configured", () => {
    expect(resolveMediaCapability({})).toEqual({ supported: false, reason: "media_gateway_required" });
    expect(resolveMediaCapability({ WHATSAPP_MEDIA_GATEWAY_URL: "https://gw.example" })).toEqual({
      supported: true,
      gatewayUrl: "https://gw.example",
    });
  });
});

describe("inbound call orchestration", () => {
  it("ignores calls for an unknown tenant", async () => {
    const { db, inserts } = makeDb({ agencyId: null });
    const outcome = await processCallEvent({
      db: db as never,
      event: parseCallEvent(CONNECT)!,
      phoneNumberId: "1232996883231810",
      env: {},
    });
    expect(outcome).toBe("ignored_unknown_tenant");
    expect(inserts.length).toBe(0);
  });

  it("records a ringing session with a bounded answer window and defers answering", async () => {
    const { db, inserts } = makeDb({ agencyId: "agency-1", existing: null });
    const now = new Date("2026-09-01T10:00:00.000Z");
    const outcome = await processCallEvent({
      db: db as never,
      event: parseCallEvent(CONNECT)!,
      phoneNumberId: "1232996883231810",
      env: {},
      now: () => now,
    });
    expect(outcome).toBe("answer_deferred_media_gateway_required");
    const row = inserts[0]!.row;
    expect(row.status).toBe("ringing");
    expect(row.answered_at).toBeUndefined();
    expect(new Date(row.answer_deadline_at).getTime() - now.getTime()).toBe(CALL_ANSWER_DELAY_MS);
    expect(CALL_ANSWER_DELAY_MS).toBeGreaterThanOrEqual(8_000);
  });

  it("marks a caller hangup before the window expires as missed", async () => {
    const { db, updates } = makeDb({ agencyId: "agency-1", existing: { id: "s1", status: "ringing" } });
    const outcome = await processCallEvent({
      db: db as never,
      event: parseCallEvent({ ...CONNECT, event: "terminate" })!,
      phoneNumberId: "1232996883231810",
      env: {},
    });
    expect(outcome).toBe("state_updated");
    expect(updates[0]!.row.status).toBe("missed");
    expect(updates[0]!.row.ended_at).toBeTruthy();
  });

  it("is idempotent: a duplicate connect on a ringing session writes nothing new", async () => {
    const { db, inserts, updates } = makeDb({ agencyId: "agency-1", existing: { id: "s1", status: "ringing" } });
    const outcome = await processCallEvent({
      db: db as never,
      event: parseCallEvent(CONNECT)!,
      phoneNumberId: "1232996883231810",
      env: {},
    });
    expect(outcome).toBe("state_regression_ignored");
    expect(inserts.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("never writes answered without a Meta-confirmed establishment", async () => {
    const { db, inserts, updates } = makeDb({ agencyId: "agency-1", existing: null });
    await processCallEvent({
      db: db as never,
      event: parseCallEvent(CONNECT)!,
      phoneNumberId: "1232996883231810",
      env: {
        WHATSAPP_MEDIA_GATEWAY_URL: "https://gw.example",
        WHATSAPP_MEDIA_GATEWAY_SECRET: "test-secret",
      },
      // The gateway is unreachable in this test: negotiation must fail closed.
      fetchImpl: (async () => {
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
    });
    const written = [...inserts, ...updates].map((w) => w.row.status);
    expect(written).not.toContain("answered");
    expect(written).toContain("answer_requested");
    expect(written).toContain("failed");
  });
});
