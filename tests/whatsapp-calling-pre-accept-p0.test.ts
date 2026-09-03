/**
 * UMRAIO® — P0 inbound-call repair regression suite.
 *
 * Proves the pre_accept lifecycle, termination cancellation, idempotency and
 * the answered rule. Every boundary (Meta, gateway, database) is a fake:
 * no network, no deployment, no tenant data.
 */
import { describe, expect, it } from "vitest";
import { processCallEvent, processGatewayCallback } from "@/lib/calls/calls.server";
import { parseCallEvent, shouldApplyCallStatus } from "@/lib/calls/call-events.core";
import { decideGatewayCallback, type CallSessionRow } from "@/lib/calls/gateway-callback.core";
import { computeCallDurations } from "@/lib/calls/call-timings.core";

const CALL_ID = "wacid.TESTP0";
const PHONE_ID = "701234567890123";
const AGENCY = "11111111-1111-1111-1111-111111111111";
const SECRET = "umraio-test-gateway-secret-0123456789";
const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const GATEWAY_SESSION = "sess-p0";

const ENV = {
  WHATSAPP_MEDIA_GATEWAY_URL: "https://gateway.internal",
  WHATSAPP_MEDIA_GATEWAY_SECRET: SECRET,
};

const CONNECT_EVENT = {
  callId: CALL_ID,
  callerPhone: "60123456789",
  status: "ringing" as const,
  direction: "inbound" as const,
  sdp: { type: "offer", sdp: OFFER_SDP },
  terminationReason: null,
  occurredAt: "2026-09-03T00:45:14.000Z",
};

const TERMINATE_EVENT = {
  ...CONNECT_EVENT,
  status: "terminated" as const,
  sdp: null,
  terminationReason: "completed",
  occurredAt: "2026-09-03T00:45:21.000Z",
};

/** Fake supabase surface with a single mutable call-session row. */
function makeDb(initial?: Record<string, unknown> | null) {
  const writes: { table: string; op: string; payload: any }[] = [];
  const state: { session: Record<string, unknown> | null } = { session: initial ?? null };
  const db = {
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        maybeSingle: async () => {
          if (table === "whatsapp_configs") {
            return { data: { agency_id: AGENCY, access_token: "meta-token" } };
          }
          return { data: state.session };
        },
        insert: async (payload: any) => {
          writes.push({ table, op: "insert", payload });
          state.session = { id: "row-1", callback_nonces: [], ...payload };
          return { data: null, error: null };
        },
        update: (payload: any) => {
          writes.push({ table, op: "update", payload });
          if (state.session) state.session = { ...state.session, ...payload };
          const chain: any = {
            eq: () => chain,
            is: () => chain,
            then: (r: any) => Promise.resolve(null).then(r),
          };
          return chain;
        },
      };
      return builder;
    },
  };
  return { db, writes, state };
}

type Recorded = { url: string; action?: string; sdp?: string; at: number };

function makeFetch(options: {
  recorded: Recorded[];
  clock: () => number;
  preAcceptStatus?: number;
  acceptStatus?: number;
  onAction?: (action: string) => void;
}): typeof fetch {
  return (async (url: any, init: any) => {
    const href = String(url);
    if (href.includes("/v1/calls/offer")) {
      options.recorded.push({ url: href, at: options.clock() });
      return new Response(
        JSON.stringify({ session_id: GATEWAY_SESSION, sdp_answer: ANSWER_SDP, state: "media_negotiating" }),
        { status: 200 },
      );
    }
    if (href.includes("/terminate")) {
      options.recorded.push({ url: href, action: "gateway_terminate", at: options.clock() });
      return new Response("{}", { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    options.recorded.push({ url: href, action: body.action, sdp: body.session?.sdp, at: options.clock() });
    options.onAction?.(body.action);
    const status =
      body.action === "pre_accept" ? (options.preAcceptStatus ?? 200) : (options.acceptStatus ?? 200);
    return new Response(JSON.stringify({ success: status === 200 }), { status });
  }) as unknown as typeof fetch;
}

describe("P0 — Meta pre_accept lifecycle", () => {
  it("sends pre_accept before the final accept, with the identical SDP answer", async () => {
    const { db } = makeDb();
    const recorded: Recorded[] = [];
    let tick = 0;
    const outcome = await processCallEvent({
      db,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: makeFetch({ recorded, clock: () => tick++ }),
    });
    expect(outcome).toBe("meta_accepted");
    const actions = recorded.filter((r) => r.action).map((r) => r.action);
    expect(actions).toEqual(["pre_accept", "accept"]);
    const [pre, acc] = recorded.filter((r) => r.action);
    expect(pre!.sdp).toBe(ANSWER_SDP);
    // Meta rejects an accept whose SDP differs from the pre_accept SDP.
    expect(acc!.sdp).toBe(pre!.sdp);
  });

  it("introduces no artificial answer delay on the critical path", async () => {
    const { db } = makeDb();
    const recorded: Recorded[] = [];
    const start = Date.now();
    await processCallEvent({
      db,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: makeFetch({ recorded, clock: () => Date.now() }),
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("falls back to a direct accept when pre_accept is refused", async () => {
    const { db } = makeDb();
    const recorded: Recorded[] = [];
    const outcome = await processCallEvent({
      db,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: makeFetch({ recorded, clock: () => 0, preAcceptStatus: 400 }),
    });
    expect(outcome).toBe("meta_accepted");
    expect(recorded.filter((r) => r.action).map((r) => r.action)).toEqual(["pre_accept", "accept"]);
  });

  it("persists stage timings for the critical path", async () => {
    const { db, state } = makeDb();
    await processCallEvent({
      db,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: makeFetch({ recorded: [], clock: () => 0 }),
    });
    const timings = state.session!["stage_timings"] as Record<string, unknown>;
    for (const stage of [
      "webhook_received_at",
      "tenant_resolved_at",
      "gateway_offer_started_at",
      "gateway_answer_received_at",
      "meta_pre_accept_started_at",
      "meta_pre_accept_completed_at",
      "meta_accept_started_at",
      "meta_accept_completed_at",
    ]) {
      expect(timings[stage]).toBeTruthy();
    }
    expect(timings["durations_ms"]).toBeTruthy();
  });

  it("computes durations for every completed stage pair", () => {
    const d = computeCallDurations({
      webhook_received_at: "2026-09-03T00:45:14.000Z",
      meta_pre_accept_completed_at: "2026-09-03T00:45:15.000Z",
      meta_accept_started_at: "2026-09-03T00:45:15.200Z",
      meta_accept_completed_at: "2026-09-03T00:45:15.600Z",
    });
    expect(d["webhook_to_pre_accept"]).toBe(1000);
    expect(d["pre_accept_to_accept"]).toBe(200);
    expect(d["meta_accept"]).toBe(400);
  });
});

describe("P0 — termination cancellation", () => {
  it("cancels the answer when TERMINATE lands before the final accept", async () => {
    const { db, state } = makeDb();
    const recorded: Recorded[] = [];
    const fetchImpl = makeFetch({
      recorded,
      clock: () => 0,
      onAction: (action) => {
        // The caller hangs up while pre_accept is in flight.
        if (action === "pre_accept" && state.session) {
          state.session = { ...state.session, status: "terminated", ended_at: TERMINATE_EVENT.occurredAt };
        }
      },
    });
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl,
    });
    expect(outcome).toBe("cancelled_by_terminate");
    expect(recorded.map((r) => r.action)).toContain("gateway_terminate");
    expect(recorded.filter((r) => r.action === "accept")).toHaveLength(0);
    expect(state.session!["meta_accepted_at"]).toBeFalsy();
    expect(state.session!["status"]).toBe("terminated");
  });

  it("never revives a call that terminated while accept was in flight", async () => {
    const { db, state } = makeDb();
    const recorded: Recorded[] = [];
    const fetchImpl = makeFetch({
      recorded,
      clock: () => 0,
      onAction: (action) => {
        if (action === "accept" && state.session) {
          state.session = { ...state.session, status: "terminated" };
        }
      },
    });
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl,
    });
    expect(outcome).toBe("cancelled_by_terminate");
    expect(state.session!["meta_accepted_at"]).toBeFalsy();
    expect(state.session!["status"]).toBe("terminated");
  });

  it("tears down the gateway session when Meta accept fails", async () => {
    const { db, state } = makeDb();
    const recorded: Recorded[] = [];
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV,
      fetchImpl: makeFetch({ recorded, clock: () => 0, acceptStatus: 500 }),
    });
    expect(outcome).toBe("negotiation_failed");
    expect(recorded.map((r) => r.action)).toContain("gateway_terminate");
    expect(state.session!["status"]).toBe("failed");
    expect(state.session!["meta_accepted_at"]).toBeFalsy();
  });

  it("tears down media when a TERMINATE webhook arrives during pre-accept state", async () => {
    const { db } = makeDb({
      id: "row-1",
      call_id: CALL_ID,
      status: "meta_pre_accepted",
      gateway_session_id: GATEWAY_SESSION,
      callback_nonces: [],
    });
    const recorded: Recorded[] = [];
    const outcome = await processCallEvent({
      db, event: TERMINATE_EVENT, phoneNumberId: PHONE_ID, env: ENV,
      fetchImpl: makeFetch({ recorded, clock: () => 0 }),
    });
    expect(outcome).toBe("state_updated");
    expect(recorded.map((r) => r.action)).toContain("gateway_terminate");
  });
});

describe("P0 — idempotency", () => {
  it("treats a duplicate CONNECT as a state regression and does nothing", async () => {
    const { db } = makeDb({
      id: "row-1", call_id: CALL_ID, status: "meta_pre_accepted", callback_nonces: [],
    });
    const recorded: Recorded[] = [];
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV,
      fetchImpl: makeFetch({ recorded, clock: () => 0 }),
    });
    expect(outcome).toBe("state_regression_ignored");
    expect(recorded).toHaveLength(0);
  });

  it("treats a duplicate TERMINATE as idempotent", async () => {
    const { db } = makeDb({
      id: "row-1", call_id: CALL_ID, status: "terminated", callback_nonces: [],
    });
    const recorded: Recorded[] = [];
    const outcome = await processCallEvent({
      db, event: TERMINATE_EVENT, phoneNumberId: PHONE_ID, env: ENV,
      fetchImpl: makeFetch({ recorded, clock: () => 0 }),
    });
    expect(outcome).toBe("state_regression_ignored");
    expect(recorded).toHaveLength(0);
  });

  it("keeps the state machine monotonic across the new pre-accept state", () => {
    expect(shouldApplyCallStatus("media_negotiating", "meta_pre_accepted")).toBe(true);
    expect(shouldApplyCallStatus("meta_pre_accepted", "media_negotiating")).toBe(false);
    expect(shouldApplyCallStatus("meta_pre_accepted", "terminated")).toBe(true);
    expect(shouldApplyCallStatus("terminated", "meta_pre_accepted")).toBe(false);
    expect(shouldApplyCallStatus("answered", "terminated")).toBe(false);
  });
});

describe("P0 — answered requires real media", () => {
  const base: CallSessionRow = {
    id: "row-1",
    call_id: CALL_ID,
    status: "meta_pre_accepted",
    gateway_session_id: GATEWAY_SESSION,
    meta_accepted_at: "2026-09-03T00:45:21.000Z",
    callback_nonces: [],
  };
  const now = new Date("2026-09-03T00:45:22.000Z");

  it("does not mark answered without a media_ready callback", async () => {
    const { db, state } = makeDb({ ...base });
    await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV,
      fetchImpl: makeFetch({ recorded: [], clock: () => 0 }),
    });
    expect(state.session!["status"]).not.toBe("answered");
  });

  it("rejects media_ready when Meta accept never completed", () => {
    const d = decideGatewayCallback({
      payload: {
        event: "media_ready", call_id: CALL_ID, session_id: GATEWAY_SESSION,
        timestamp: now.toISOString(), nonce: "n1",
      },
      session: { ...base, meta_accepted_at: null },
      now,
    });
    expect(d).toEqual({ apply: false, rejection: "media_ready_without_meta_accept" });
  });

  it("marks answered only on media_ready after a completed accept, and records RTP timings", async () => {
    const { db, state } = makeDb({ ...base, stage_timings: { webhook_received_at: "2026-09-03T00:45:14.000Z" } });
    const result = await processGatewayCallback({
      db,
      payload: {
        event: "media_ready", call_id: CALL_ID, session_id: GATEWAY_SESSION,
        timestamp: now.toISOString(), nonce: "n1", inbound_packets: 120, outbound_packets: 90,
      },
      now: () => now,
    });
    expect(result).toEqual({ applied: true, outcome: "answered" });
    expect(state.session!["status"]).toBe("answered");
    const timings = state.session!["stage_timings"] as Record<string, unknown>;
    expect(timings["media_ready_at"]).toBe(now.toISOString());
    expect(timings["first_inbound_rtp_at"]).toBe(now.toISOString());
    expect(timings["first_outbound_rtp_at"]).toBe(now.toISOString());
  });
});

describe("P0 — messaging is untouched", () => {
  it("still ignores non-call Meta events in the call parser", () => {
    expect(parseCallEvent({ id: CALL_ID, from: "60123456789", event: "ringing" })).toBeNull();
    expect(parseCallEvent({ id: CALL_ID, from: "60123456789", event: "connect" })?.status).toBe("ringing");
  });

  it("forwards Meta SDP byte-for-byte to the gateway", () => {
    const parsed = parseCallEvent({
      id: CALL_ID, from: "60123456789", event: "connect",
      session: { sdp_type: "offer", sdp: OFFER_SDP },
    });
    expect(parsed?.sdp?.sdp).toBe(OFFER_SDP);
  });
});
