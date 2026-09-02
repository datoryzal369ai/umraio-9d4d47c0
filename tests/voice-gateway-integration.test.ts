/**
 * UMRAIO® — Phase 2: control plane <-> media gateway integration tests.
 * No network, no Meta call, no deployment: every boundary is a fake.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOKEN_LIFETIME_MS,
  GATEWAY_TOKEN_SCOPE,
  MAX_TOKEN_LIFETIME_MS,
  mintVoiceGatewaySessionToken,
  signGatewayRequest,
  verifyGatewayCallbackSignature,
} from "@/lib/calls/gateway-auth.core";
import {
  appendCallbackNonce,
  decideGatewayCallback,
  MAX_CALLBACK_NONCES,
  parseGatewayCallback,
  type CallSessionRow,
  type GatewayCallbackPayload,
} from "@/lib/calls/gateway-callback.core";
import { requestMediaSession } from "@/lib/calls/media-gateway.server";
import { metaAcceptCall } from "@/lib/calls/meta-calls.server";
import { processCallEvent, processGatewayCallback } from "@/lib/calls/calls.server";
import { shouldApplyCallStatus } from "@/lib/calls/call-events.core";

const SECRET = "umraio-test-gateway-secret-0123456789";
const CALL_ID = "wacid.HBgLNjAxMTEwNjM5OTk2";
const AGENCY = "11111111-1111-1111-1111-111111111111";
const OTHER_AGENCY = "22222222-2222-2222-2222-222222222222";
const PHONE_ID = "701234567890123";
const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const GATEWAY_SESSION = "sess-abc123";

function decodeClaims(token: string) {
  const payload = token.split(".")[0]!;
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** Minimal fake of the supabase query builder surface used by calls.server. */
function makeDb(options: {
  config?: { agency_id: string; access_token: string | null } | null;
  session?: Record<string, unknown> | null;
}) {
  const writes: { table: string; op: string; payload: any }[] = [];
  const state = { session: options.session ?? null };
  const db = {
    from(table: string) {
      const builder: any = {
        _table: table,
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === "whatsapp_configs") return { data: options.config ?? null };
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
  occurredAt: "2026-09-01T10:00:00.000Z",
};

function okGatewayFetch(): typeof fetch {
  return (async (url: any) => {
    if (String(url).includes("/v1/calls/offer")) {
      return new Response(
        JSON.stringify({ session_id: GATEWAY_SESSION, sdp_answer: ANSWER_SDP, state: "media_negotiating" }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ── Session token ───────────────────────────────────────────────────────────

describe("session token", () => {
  it("mints all required claims and nothing else", async () => {
    const { token } = await mintVoiceGatewaySessionToken({
      secret: SECRET, callId: CALL_ID, agencyId: AGENCY, phoneNumberId: PHONE_ID,
    });
    const claims = decodeClaims(token);
    expect(Object.keys(claims).sort()).toEqual(
      ["agency_id", "call_id", "exp", "iat", "nonce", "phone_number_id", "scope"],
    );
    expect(claims.scope).toBe(GATEWAY_TOKEN_SCOPE);
    expect(token.split(".")).toHaveLength(2);
  });

  it("carries no credential of any kind", async () => {
    const { token } = await mintVoiceGatewaySessionToken({
      secret: SECRET, callId: CALL_ID, agencyId: AGENCY, phoneNumberId: PHONE_ID,
    });
    const raw = JSON.stringify(decodeClaims(token)).toLowerCase();
    for (const banned of ["access_token", "service_role", "supabase", "apikey", "secret", "minimax", "openai"]) {
      expect(raw).not.toContain(banned);
    }
    expect(raw).not.toContain(SECRET.toLowerCase());
  });

  it("expires well within the gateway ceiling", async () => {
    const now = new Date("2026-09-01T10:00:00.000Z");
    const { claims } = await mintVoiceGatewaySessionToken({
      secret: SECRET, callId: CALL_ID, agencyId: AGENCY, phoneNumberId: PHONE_ID, now,
    });
    expect((claims.exp - claims.iat) * 1000).toBe(DEFAULT_TOKEN_LIFETIME_MS);
    expect((claims.exp - claims.iat) * 1000).toBeLessThanOrEqual(MAX_TOKEN_LIFETIME_MS);
  });

  it("clamps an over-long requested lifetime to the 15 minute maximum", async () => {
    const { claims } = await mintVoiceGatewaySessionToken({
      secret: SECRET, callId: CALL_ID, agencyId: AGENCY, phoneNumberId: PHONE_ID, ttlMs: 60 * 60 * 1000,
    });
    expect((claims.exp - claims.iat) * 1000).toBe(MAX_TOKEN_LIFETIME_MS);
  });

  it("refuses to mint without a secret or with a missing claim", async () => {
    await expect(mintVoiceGatewaySessionToken({
      secret: "", callId: CALL_ID, agencyId: AGENCY, phoneNumberId: PHONE_ID,
    })).rejects.toThrow("gateway_secret_missing");
    await expect(mintVoiceGatewaySessionToken({
      secret: SECRET, callId: CALL_ID, agencyId: "", phoneNumberId: PHONE_ID,
    })).rejects.toThrow("gateway_token_missing_claim");
  });

  it("produces a distinct nonce per call", async () => {
    const a = await mintVoiceGatewaySessionToken({ secret: SECRET, callId: CALL_ID, agencyId: AGENCY, phoneNumberId: PHONE_ID });
    const b = await mintVoiceGatewaySessionToken({ secret: SECRET, callId: CALL_ID, agencyId: AGENCY, phoneNumberId: PHONE_ID });
    expect(a.claims.nonce).not.toBe(b.claims.nonce);
  });
});

// ── Callback HMAC ───────────────────────────────────────────────────────────

describe("callback HMAC", () => {
  const body = JSON.stringify({ event: "media_ready", call_id: CALL_ID });
  const now = new Date("2026-09-01T10:00:00.000Z");
  const ts = Math.floor(now.getTime() / 1000);

  it("accepts a correctly signed, fresh request", async () => {
    const signature = await signGatewayRequest(SECRET, ts, body);
    expect(await verifyGatewayCallbackSignature({ secret: SECRET, signature, timestamp: String(ts), rawBody: body, now }))
      .toEqual({ ok: true });
  });

  it("rejects a forged signature", async () => {
    const signature = await signGatewayRequest("wrong-secret", ts, body);
    const r = await verifyGatewayCallbackSignature({ secret: SECRET, signature, timestamp: String(ts), rawBody: body, now });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered body under a valid signature", async () => {
    const signature = await signGatewayRequest(SECRET, ts, body);
    const r = await verifyGatewayCallbackSignature({
      secret: SECRET, signature, timestamp: String(ts), rawBody: body + " ", now,
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp outside the skew window", async () => {
    const oldTs = ts - 600;
    const signature = await signGatewayRequest(SECRET, oldTs, body);
    const r = await verifyGatewayCallbackSignature({ secret: SECRET, signature, timestamp: String(oldTs), rawBody: body, now });
    expect(r).toEqual({ ok: false, reason: "stale_request" });
  });

  it("rejects missing headers, bad timestamps and an unset secret", async () => {
    expect((await verifyGatewayCallbackSignature({ secret: SECRET, signature: null, timestamp: String(ts), rawBody: body, now })).ok).toBe(false);
    expect((await verifyGatewayCallbackSignature({ secret: SECRET, signature: "v1=x", timestamp: "abc", rawBody: body, now })).ok).toBe(false);
    expect((await verifyGatewayCallbackSignature({ secret: "", signature: "v1=x", timestamp: String(ts), rawBody: body, now })).ok).toBe(false);
  });
});

// ── Callback payload + decision core ────────────────────────────────────────

const baseSession: CallSessionRow = {
  id: "row-1",
  call_id: CALL_ID,
  status: "media_negotiating",
  gateway_session_id: GATEWAY_SESSION,
  meta_accepted_at: "2026-09-01T10:00:02.000Z",
  callback_nonces: [],
};

const readyEvent: GatewayCallbackPayload = {
  event: "media_ready",
  call_id: CALL_ID,
  session_id: GATEWAY_SESSION,
  timestamp: "2026-09-01T10:00:03.000Z",
  nonce: "n1",
};

const NOW = new Date("2026-09-01T10:00:03.500Z");

describe("callback payload validation", () => {
  it("accepts a well-formed event", () => {
    expect(parseGatewayCallback(readyEvent)?.event).toBe("media_ready");
  });

  it("rejects unsupported events and malformed payloads", () => {
    expect(parseGatewayCallback({ ...readyEvent, event: "call_answered" })).toBeNull();
    expect(parseGatewayCallback({ ...readyEvent, call_id: "" })).toBeNull();
    expect(parseGatewayCallback({ ...readyEvent, nonce: "" })).toBeNull();
    expect(parseGatewayCallback(null)).toBeNull();
    expect(parseGatewayCallback("media_ready")).toBeNull();
  });

  it("ignores any agency identifier the gateway tries to assert", () => {
    const parsed = parseGatewayCallback({ ...readyEvent, agency_id: OTHER_AGENCY });
    expect(JSON.stringify(parsed)).not.toContain(OTHER_AGENCY);
  });

  it("bounds the per-call nonce ledger", () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_CALLBACK_NONCES + 10; i += 1) list = appendCallbackNonce(list, `n${i}`);
    expect(list).toHaveLength(MAX_CALLBACK_NONCES);
  });
});

describe("answered rule", () => {
  it("answers only after Meta accept AND media_ready", () => {
    const d = decideGatewayCallback({ payload: readyEvent, session: baseSession, now: NOW });
    expect(d).toMatchObject({ apply: true, outcome: "answered" });
    if (d.apply) expect(d.patch["status"]).toBe("answered");
  });

  it("REJECTS media_ready that arrives before Meta accept", () => {
    const d = decideGatewayCallback({
      payload: readyEvent, session: { ...baseSession, meta_accepted_at: null }, now: NOW,
    });
    expect(d).toEqual({ apply: false, rejection: "media_ready_without_meta_accept" });
  });

  it("rejects an unknown call_id", () => {
    expect(decideGatewayCallback({ payload: readyEvent, session: null, now: NOW }))
      .toEqual({ apply: false, rejection: "unknown_call" });
  });

  it("rejects a call_id that does not correlate to the loaded row", () => {
    expect(decideGatewayCallback({ payload: readyEvent, session: { ...baseSession, call_id: "other" }, now: NOW }))
      .toEqual({ apply: false, rejection: "call_id_mismatch" });
  });

  it("rejects a gateway session mismatch", () => {
    expect(decideGatewayCallback({ payload: { ...readyEvent, session_id: "sess-evil" }, session: baseSession, now: NOW }))
      .toEqual({ apply: false, rejection: "gateway_session_mismatch" });
    expect(decideGatewayCallback({ payload: readyEvent, session: { ...baseSession, gateway_session_id: null }, now: NOW }))
      .toEqual({ apply: false, rejection: "gateway_session_mismatch" });
  });

  it("rejects a replayed nonce", () => {
    expect(decideGatewayCallback({ payload: readyEvent, session: { ...baseSession, callback_nonces: ["n1"] }, now: NOW }))
      .toEqual({ apply: false, rejection: "replayed_nonce" });
  });

  it("treats a duplicate media_ready as a no-op", () => {
    expect(decideGatewayCallback({
      payload: { ...readyEvent, nonce: "n2" }, session: { ...baseSession, status: "answered" }, now: NOW,
    })).toEqual({ apply: false, rejection: "duplicate_event" });
  });

  it("never resurrects a terminal call", () => {
    for (const status of ["missed", "terminated", "failed"]) {
      expect(decideGatewayCallback({ payload: { ...readyEvent, nonce: status }, session: { ...baseSession, status }, now: NOW }))
        .toEqual({ apply: false, rejection: "session_terminal" });
    }
  });

  it("applies media_terminated and media_failed with a non-sensitive reason", () => {
    const t = decideGatewayCallback({
      payload: { ...readyEvent, event: "media_terminated", nonce: "n3", reason: "peer_hangup" },
      session: baseSession, now: NOW,
    });
    expect(t).toMatchObject({ apply: true, outcome: "terminated" });
    const f = decideGatewayCallback({
      payload: { ...readyEvent, event: "media_failed", nonce: "n4", reason: "ice_failed" },
      session: baseSession, now: NOW,
    });
    expect(f).toMatchObject({ apply: true, outcome: "failed" });
    if (f.apply) expect(f.patch["termination_reason"]).toBe("ice_failed");
  });
});

// ── State machine ───────────────────────────────────────────────────────────

describe("state monotonicity", () => {
  it("moves forward ringing -> answer_requested -> media_negotiating -> answered", () => {
    expect(shouldApplyCallStatus("ringing", "media_negotiating")).toBe(true);
    expect(shouldApplyCallStatus("answer_requested", "answered")).toBe(true);
  });

  it("never regresses", () => {
    expect(shouldApplyCallStatus("media_negotiating", "ringing")).toBe(false);
    expect(shouldApplyCallStatus("answered", "ringing")).toBe(false);
    expect(shouldApplyCallStatus("terminated", "media_negotiating")).toBe(false);
  });
});

// ── Gateway + Meta clients ──────────────────────────────────────────────────

describe("requestMediaSession", () => {
  it("signs the request with both HMAC layers and returns the real answer", async () => {
    let seen: any = null;
    const fetchImpl = (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ session_id: GATEWAY_SESSION, sdp_answer: ANSWER_SDP }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await requestMediaSession({
      gatewayUrl: "https://gateway.internal/", secret: SECRET, callId: CALL_ID,
      agencyId: AGENCY, phoneNumberId: PHONE_ID, sdpOffer: OFFER_SDP, fetchImpl,
    });
    expect(r).toMatchObject({ ok: true, sessionId: GATEWAY_SESSION, sdpAnswer: ANSWER_SDP.trim() });
    expect(seen.url).toBe("https://gateway.internal/v1/calls/offer");
    expect(seen.init.headers["Authorization"]).toMatch(/^Bearer /);
    expect(seen.init.headers["X-Umraio-Signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(seen.init.headers["X-Umraio-Timestamp"]).toMatch(/^\d+$/);
    expect(seen.init.body).not.toContain(SECRET);
  });

  it("fails closed when the gateway is unavailable, errors, or replies malformed", async () => {
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await requestMediaSession({
      gatewayUrl: "https://g", secret: SECRET, callId: CALL_ID, agencyId: AGENCY,
      phoneNumberId: PHONE_ID, sdpOffer: OFFER_SDP, fetchImpl: boom,
    })).toEqual({ ok: false, reason: "gateway_unavailable" });

    const five = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    expect(await requestMediaSession({
      gatewayUrl: "https://g", secret: SECRET, callId: CALL_ID, agencyId: AGENCY,
      phoneNumberId: PHONE_ID, sdpOffer: OFFER_SDP, fetchImpl: five,
    })).toEqual({ ok: false, reason: "gateway_http_502" });

    const empty = (async () => new Response(JSON.stringify({ session_id: "s" }), { status: 200 })) as unknown as typeof fetch;
    expect(await requestMediaSession({
      gatewayUrl: "https://g", secret: SECRET, callId: CALL_ID, agencyId: AGENCY,
      phoneNumberId: PHONE_ID, sdpOffer: OFFER_SDP, fetchImpl: empty,
    })).toEqual({ ok: false, reason: "gateway_invalid_response" });
  });

  it("never fabricates an SDP offer", async () => {
    expect(await requestMediaSession({
      gatewayUrl: "https://g", secret: SECRET, callId: CALL_ID, agencyId: AGENCY,
      phoneNumberId: PHONE_ID, sdpOffer: "   ",
    })).toEqual({ ok: false, reason: "missing_remote_sdp" });
  });
});

describe("metaAcceptCall", () => {
  it("sends the gateway answer to Meta and reports success", async () => {
    let body: any = null;
    const fetchImpl = (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await metaAcceptCall({
      phoneNumberId: PHONE_ID, accessToken: "meta-token", callId: CALL_ID, sdpAnswer: ANSWER_SDP, fetchImpl,
    })).toEqual({ ok: true });
    expect(body).toMatchObject({ action: "accept", call_id: CALL_ID, session: { sdp_type: "answer", sdp: ANSWER_SDP } });
  });

  it("reports failure without leaking the provider payload", async () => {
    const fetchImpl = (async () => new Response("token leaked here", { status: 401 })) as unknown as typeof fetch;
    const r = await metaAcceptCall({
      phoneNumberId: PHONE_ID, accessToken: "meta-token", callId: CALL_ID, sdpAnswer: ANSWER_SDP, fetchImpl,
    });
    expect(r).toEqual({ ok: false, reason: "meta_accept_http_401" });
  });

  it("refuses to accept without a real answer or a token", async () => {
    expect((await metaAcceptCall({ phoneNumberId: PHONE_ID, accessToken: "", callId: CALL_ID, sdpAnswer: ANSWER_SDP })).ok).toBe(false);
    expect((await metaAcceptCall({ phoneNumberId: PHONE_ID, accessToken: "t", callId: CALL_ID, sdpAnswer: "" })).ok).toBe(false);
  });
});

// ── Orchestration ───────────────────────────────────────────────────────────

describe("connect -> negotiation orchestration", () => {
  const config = { agency_id: AGENCY, access_token: "meta-token" };

  it("drives ringing -> answer_requested -> media_negotiating -> meta accepted", async () => {
    const { db, writes } = makeDb({ config, session: null });
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl: okGatewayFetch(),
    });
    expect(outcome).toBe("meta_accepted");
    const statuses = writes.filter((w) => w.op === "update").map((w) => w.payload.status);
    expect(statuses).toEqual(["answer_requested", "media_negotiating", undefined]);
    const negotiating = writes.find((w) => w.payload.status === "media_negotiating")!;
    expect(negotiating.payload.gateway_session_id).toBe(GATEWAY_SESSION);
    expect(negotiating.payload.media_negotiated_at).toBeTruthy();
    // Crucially: nothing anywhere set answered.
    expect(JSON.stringify(writes)).not.toContain('"answered"');
  });

  it("defers with no gateway configured and writes no answered state", async () => {
    const { db, writes } = makeDb({ config, session: null });
    const outcome = await processCallEvent({ db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: {} });
    expect(outcome).toBe("answer_deferred_media_gateway_required");
    expect(JSON.stringify(writes)).not.toContain("answered");
  });

  it("defers when the gateway URL exists but the shared secret does not", async () => {
    const { db } = makeDb({ config, session: null });
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: { WHATSAPP_MEDIA_GATEWAY_URL: "https://g" },
    });
    expect(outcome).toBe("answer_deferred_media_gateway_required");
  });

  it("marks the call failed when the gateway is down", async () => {
    const { db, writes } = makeDb({ config, session: null });
    const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl: down,
    });
    expect(outcome).toBe("negotiation_failed");
    expect(writes.at(-1)!.payload).toMatchObject({ status: "failed", termination_reason: "gateway_unavailable" });
  });

  it("marks the call failed and tears media down when Meta accept fails", async () => {
    const { db, writes } = makeDb({ config, session: null });
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      calls.push(String(url));
      if (String(url).includes("/v1/calls/offer")) {
        return new Response(JSON.stringify({ session_id: GATEWAY_SESSION, sdp_answer: ANSWER_SDP }), { status: 200 });
      }
      if (String(url).includes("graph.facebook.com")) return new Response("no", { status: 400 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await processCallEvent({ db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl });
    expect(outcome).toBe("negotiation_failed");
    expect(calls.some((c) => c.includes("/terminate"))).toBe(true);
    expect(writes.at(-1)!.payload).toMatchObject({ status: "failed", termination_reason: "meta_accept_http_400" });
    expect(JSON.stringify(writes)).not.toContain("meta_accepted_at");
  });

  it("fails closed when the tenant has no Meta token", async () => {
    const { db, writes } = makeDb({ config: { agency_id: AGENCY, access_token: null }, session: null });
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl: okGatewayFetch(),
    });
    expect(outcome).toBe("negotiation_failed");
    expect(writes.at(-1)!.payload.termination_reason).toBe("meta_token_missing");
  });

  it("ignores an event for an unknown phone_number_id (cross-tenant isolation)", async () => {
    const { db, writes } = makeDb({ config: null, session: null });
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: "999", env: ENV, fetchImpl: okGatewayFetch(),
    });
    expect(outcome).toBe("ignored_unknown_tenant");
    expect(writes).toHaveLength(0);
  });

  it("scopes the minted token to the resolved tenant, not to anything in the event", async () => {
    const { db } = makeDb({ config, session: null });
    let bearer = "";
    const fetchImpl = (async (url: any, init: any) => {
      if (String(url).includes("/v1/calls/offer")) {
        bearer = init.headers["Authorization"].replace("Bearer ", "");
        return new Response(JSON.stringify({ session_id: GATEWAY_SESSION, sdp_answer: ANSWER_SDP }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await processCallEvent({ db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl });
    const claims = decodeClaims(bearer);
    expect(claims.agency_id).toBe(AGENCY);
    expect(claims.agency_id).not.toBe(OTHER_AGENCY);
    expect(claims.call_id).toBe(CALL_ID);
  });

  it("terminates the media session when the caller hangs up during negotiation", async () => {
    const { db } = makeDb({ config, session: { id: "row-1", status: "media_negotiating" } });
    const seen: string[] = [];
    const fetchImpl = (async (url: any) => { seen.push(String(url)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const outcome = await processCallEvent({
      db,
      event: { ...CONNECT_EVENT, status: "missed", terminationReason: "caller_hangup", sdp: null },
      phoneNumberId: PHONE_ID, env: ENV, fetchImpl,
    });
    expect(outcome).toBe("state_updated");
    expect(seen.some((u) => u.includes("/terminate"))).toBe(true);
  });

  it("ignores a duplicate connect for a call already answered", async () => {
    const { db, writes } = makeDb({ config, session: { id: "row-1", status: "answered" } });
    const outcome = await processCallEvent({
      db, event: CONNECT_EVENT, phoneNumberId: PHONE_ID, env: ENV, fetchImpl: okGatewayFetch(),
    });
    expect(outcome).toBe("state_regression_ignored");
    expect(writes).toHaveLength(0);
  });
});

describe("processGatewayCallback", () => {
  it("writes answered exactly once, after accept + media_ready", async () => {
    const { db, writes } = makeDb({ session: { ...baseSession } });
    const r = await processGatewayCallback({ db, payload: readyEvent });
    expect(r).toEqual({ applied: true, outcome: "answered" });
    expect(writes.at(-1)!.payload).toMatchObject({ status: "answered" });
    expect(writes.at(-1)!.payload.callback_nonces).toEqual(["n1"]);
  });

  it("does not write anything when the answered rule is not satisfied", async () => {
    const { db, writes } = makeDb({ session: { ...baseSession, meta_accepted_at: null } });
    const r = await processGatewayCallback({ db, payload: readyEvent });
    expect(r).toEqual({ applied: false, rejection: "media_ready_without_meta_accept" });
    expect(writes).toHaveLength(0);
  });

  it("rejects a replayed callback on the second delivery", async () => {
    const { db } = makeDb({ session: { ...baseSession } });
    expect((await processGatewayCallback({ db, payload: readyEvent })).applied).toBe(true);
    expect(await processGatewayCallback({ db, payload: readyEvent })).toEqual({
      applied: false, rejection: "replayed_nonce",
    });
  });

  it("rejects a callback for an unknown call", async () => {
    const { db } = makeDb({ session: null });
    expect(await processGatewayCallback({ db, payload: readyEvent })).toEqual({
      applied: false, rejection: "unknown_call",
    });
  });

  it("does not log customer identifiers beyond the call id", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db } = makeDb({ session: { ...baseSession } });
    await processGatewayCallback({ db, payload: readyEvent });
    const logged = spy.mock.calls.flat().join(" ");
    spy.mockRestore();
    expect(logged).not.toContain(AGENCY);
    expect(logged).not.toContain(SECRET);
  });
});

describe("sdp terminator forwarding", () => {
  it("sends the SDP offer to the gateway with its terminator intact", async () => {
    const offer = OFFER_SDP; // ends with \r\n
    let sentBody = "";
    const fetchImpl = (async (_url: any, init: any) => {
      sentBody = String(init.body);
      return new Response(
        JSON.stringify({ session_id: GATEWAY_SESSION, sdp_answer: ANSWER_SDP, state: "media_negotiating" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await requestMediaSession({
      gatewayUrl: "https://gateway.internal",
      secret: SECRET,
      callId: CALL_ID,
      agencyId: AGENCY,
      phoneNumberId: PHONE_ID,
      sdpOffer: offer,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(sentBody).sdp_offer).toBe(offer);
  });
});
