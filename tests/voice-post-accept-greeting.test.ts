/**
 * UMRAIO® — post-accept greeting trigger (control plane side).
 *
 * Locks down the deadlock repair: nothing may speak before Meta `accept`
 * completes, and exactly one notification is sent to the gateway immediately
 * after it does — the gateway keeps the greeting itself idempotent.
 */
import { describe, expect, it } from "vitest";
import { processCallEvent } from "@/lib/calls/calls.server";
import { notifyCallAccepted } from "@/lib/calls/media-gateway.server";

const SECRET = "umraio-test-gateway-secret-0123456789";
const CALL_ID = "wacid.PostAcceptGreeting";
const AGENCY = "11111111-1111-1111-1111-111111111111";
const PHONE_ID = "701234567890123";
const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

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
  occurredAt: "2026-09-03T10:00:00.000Z",
};

function makeDb(session: Record<string, unknown> | null = null) {
  const writes: { table: string; op: string; payload: any }[] = [];
  const state = { session };
  const db = {
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === "whatsapp_configs") {
            return { data: { agency_id: AGENCY, access_token: "meta-token" } };
          }
          return { data: state.session };
        },
        insert: async (payload: any) => {
          writes.push({ table, op: "insert", payload });
          state.session = { id: "row-1", ...payload };
          return { data: null, error: null };
        },
        update: (payload: any) => {
          writes.push({ table, op: "update", payload });
          if (state.session) state.session = { ...state.session, ...payload };
          const chain: any = { eq: () => chain, then: (r: any) => Promise.resolve(null).then(r) };
          return chain;
        },
      };
      return builder;
    },
  };
  return { db, writes, state };
}

/** Records the exact ordering of every outbound HTTP call. */
function recordingFetch(options: { acceptOk?: boolean } = {}) {
  const calls: string[] = [];
  const impl = (async (url: any, init?: any) => {
    const href = String(url);
    if (href.includes("/v1/calls/offer")) {
      calls.push("gateway_offer");
      return new Response(
        JSON.stringify({ session_id: "ms_test", sdp_answer: ANSWER_SDP, state: "media_negotiating" }),
        { status: 200 },
      );
    }
    if (href.includes("/accepted")) {
      calls.push("gateway_accepted");
      return new Response(JSON.stringify({ call_id: CALL_ID, greeting: "started" }), { status: 200 });
    }
    if (href.includes("/terminate")) {
      calls.push("gateway_terminate");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("pre_accept")) {
      calls.push("meta_pre_accept");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (body.includes("accept")) {
      calls.push("meta_accept");
      return options.acceptOk === false
        ? new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 })
        : new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    calls.push("other");
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("post-accept greeting trigger", () => {
  it("notifies the gateway only after Meta accept succeeds", async () => {
    const { db } = makeDb();
    const { impl, calls } = recordingFetch();

    const outcome = await processCallEvent({
      db: db as any,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: impl,
    });

    expect(outcome).toBe("meta_accepted");
    const acceptedAt = calls.indexOf("gateway_accepted");
    expect(acceptedAt).toBeGreaterThan(-1);
    expect(calls.indexOf("meta_accept")).toBeLessThan(acceptedAt);
    expect(calls.indexOf("meta_pre_accept")).toBeLessThan(calls.indexOf("meta_accept"));
    // exactly one notification per call
    expect(calls.filter((c) => c === "gateway_accepted")).toHaveLength(1);
  });

  it("never notifies the gateway when Meta accept fails, and tears the session down", async () => {
    const { db } = makeDb();
    const { impl, calls } = recordingFetch({ acceptOk: false });

    await processCallEvent({
      db: db as any,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: impl,
    });

    expect(calls).not.toContain("gateway_accepted");
    expect(calls).toContain("gateway_terminate");
  });

  it("does not mark the call answered on accept alone", async () => {
    const { db, writes } = makeDb();
    const { impl } = recordingFetch();

    await processCallEvent({
      db: db as any,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: impl,
    });

    const statuses = writes
      .map((w) => (w.payload as any)?.status)
      .filter((s): s is string => typeof s === "string");
    expect(statuses).not.toContain("answered");
  });

  it("records the notification timing without leaking media detail", async () => {
    const { db, writes } = makeDb();
    const { impl } = recordingFetch();

    await processCallEvent({
      db: db as any,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: impl,
    });

    const timings = writes
      .map((w) => (w.payload as any)?.stage_timings)
      .filter(Boolean)
      .at(-1) as Record<string, unknown> | undefined;
    expect(timings?.["post_accept_notified_at"]).toEqual(expect.any(String));
    expect(JSON.stringify(timings)).not.toContain("m=audio");
  });

  it("fails soft — a gateway outage never throws into the webhook path", async () => {
    const down = (async () => {
      throw new Error("gateway down");
    }) as unknown as typeof fetch;

    await expect(
      notifyCallAccepted({
        gatewayUrl: ENV.WHATSAPP_MEDIA_GATEWAY_URL,
        secret: SECRET,
        callId: CALL_ID,
        agencyId: AGENCY,
        phoneNumberId: PHONE_ID,
        fetchImpl: down,
      }),
    ).resolves.toEqual({ ok: false, reason: "gateway_unavailable" });
  });

  it("carries a signed, scoped session token and no credential", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const capture = (async (_url: any, init?: any) => {
      seen = {
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ""),
      };
      return new Response(JSON.stringify({ greeting: "started" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await notifyCallAccepted({
      gatewayUrl: ENV.WHATSAPP_MEDIA_GATEWAY_URL,
      secret: SECRET,
      callId: CALL_ID,
      agencyId: AGENCY,
      phoneNumberId: PHONE_ID,
      fetchImpl: capture,
    });

    expect(result).toEqual({ ok: true, greeting: "started" });
    const headers = seen!.headers;
    expect(headers["authorization"]).toMatch(/^Bearer /);
    expect(headers["x-umraio-signature"] ?? headers["x-umraio-gateway-signature"]).toBeTruthy();
    const raw = JSON.stringify(seen).toLowerCase();
    expect(raw).not.toContain(SECRET.toLowerCase());
    expect(raw).not.toContain("meta-token");
  });
});
