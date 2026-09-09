/**
 * UMRAIO® — WhatsApp Calling P0 lifecycle repairs (control plane).
 *
 * Verified defects covered (roadmap, 2026-09):
 *  1. Persistence compatibility — `call_summary` / `internal` are supported and
 *     every DB error on the call path is observable, never swallowed.
 *  2. Graceful termination — best-effort, duplicate-safe Meta `terminate`
 *     after `conversation_complete`, using tenant credentials the Worker
 *     resolved itself.
 *  4. Timing / callback integrity — first-write-wins anchors, confirmed (not
 *     assumed) post-accept notification, enumerated lifecycle outcomes.
 * Plus: MiniMax 2053 classified as entitlement, `call_summary` renders as text.
 */
import { describe, expect, it, vi } from "vitest";
import { processCallEvent, processGatewayCallback } from "@/lib/calls/calls.server";
import { CallTimeline, hasCallTimingMark, mergeCallTimings } from "@/lib/calls/call-timings.core";
import { metaTerminateCall } from "@/lib/calls/meta-calls.server";
import {
  isGracefulCompletion,
  shouldTerminateAtMeta,
  type GatewayCallbackPayload,
} from "@/lib/calls/gateway-callback.core";
import { isGreetingConfirmed, postAcceptNotifyOutcome } from "@/lib/calls/media-gateway.server";
import {
  CALL_MEMORY_DELIVERY_STATUS,
  CALL_MEMORY_MODALITY,
  finalizeCallMemory,
  persistCallMemory,
} from "@/lib/calls/call-context.server";
import { mediaKindOf } from "@/lib/conversations/media.core";
import { classifyMinimaxStatusCode, MINIMAX_ENTITLEMENT_CODES } from "@/lib/voice/minimax.server";

const SECRET = "umraio-test-gateway-secret-0123456789";
const CALL_ID = "wacid.P0Lifecycle";
const AGENCY = "11111111-1111-1111-1111-111111111111";
const PHONE_ID = "701234567890123";
const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ENV = { WHATSAPP_MEDIA_GATEWAY_URL: "https://gateway.internal", WHATSAPP_MEDIA_GATEWAY_SECRET: SECRET };

/* ------------------------------------------------------------------ */
/* Fakes                                                                */
/* ------------------------------------------------------------------ */

type Write = { table: string; op: string; payload: any; filters: [string, unknown][] };

function makeDb(options: {
  session?: Record<string, unknown> | null;
  config?: { agency_id: string; access_token: string | null } | null;
  /** Return this error from every update on the given table. */
  failUpdates?: { table: string; code: string };
  /** Return this error from inserts on the given table. */
  failInserts?: { table: string; code: string };
  /** Message row found by the call-memory lookup (null = none). */
  existingMemoryId?: string | null;
}) {
  const writes: Write[] = [];
  const state = { session: options.session ?? null };
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const result = (payload: unknown, op: string) => {
        const execute = () => {
          const failure =
            op === "update" && options.failUpdates?.table === table
              ? { code: options.failUpdates.code, message: "boom" }
              : op === "insert" && options.failInserts?.table === table
                ? { code: options.failInserts.code, message: "boom" }
                : null;
          let data = null;
          if (
            !failure &&
            op === "update" &&
            table === "whatsapp_call_sessions" &&
            state.session &&
            filters.every(([key, value]) => state.session![key] === value)
          ) {
            state.session = { ...state.session, ...(payload as object) };
            data = state.session;
          }
          writes.push({ table, op, payload, filters: [...filters] });
          return Promise.resolve({ data, error: failure });
        };
        const chain: any = {
          eq: (k: string, v: unknown) => {
            filters.push([k, v]);
            return chain;
          },
          is: (k: string, v: unknown) => {
            filters.push([k, v]);
            return chain;
          },
          select: () => chain,
          maybeSingle: execute,
          then: (resolve: any, reject?: any) => execute().then(resolve, reject),
        };
        return chain;
      };
      const builder: any = {
        select: () => builder,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return builder;
        },
        ilike: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (table === "conversations") return { data: { id: "conv-1" }, error: null };
          if (table === "whatsapp_configs") {
            return { data: options.config === undefined ? { agency_id: AGENCY, access_token: "meta-token" } : options.config };
          }
          if (table === "messages") {
            return { data: options.existingMemoryId ? { id: options.existingMemoryId } : null, error: null };
          }
          return { data: state.session, error: null };
        },
        insert: (payload: unknown) => {
          if (table === "whatsapp_call_sessions") state.session = { id: "row-1", ...(payload as object) };
          return result(payload, "insert");
        },
        update: (payload: unknown) => result(payload, "update"),
      };
      return builder;
    },
  };
  return { db: db as any, writes, state };
}

function metaFetch(options: { greeting?: string; terminateStatus?: number } = {}) {
  const calls: { kind: string; body?: any }[] = [];
  const impl = (async (url: any, init?: any) => {
    const href = String(url);
    const body = typeof init?.body === "string" ? init.body : "";
    if (href.includes("/v1/calls/offer")) {
      calls.push({ kind: "gateway_offer" });
      return new Response(JSON.stringify({ session_id: "ms_test", sdp_answer: ANSWER_SDP, state: "media_negotiating" }), {
        status: 200,
      });
    }
    if (href.includes("/accepted")) {
      calls.push({ kind: "gateway_accepted" });
      return new Response(JSON.stringify({ call_id: CALL_ID, greeting: options.greeting ?? "started" }), { status: 200 });
    }
    if (href.includes("/terminate")) {
      calls.push({ kind: "gateway_terminate" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (href.includes("graph.facebook.com")) {
      const parsed = JSON.parse(body);
      calls.push({ kind: `meta_${parsed.action}`, body: parsed });
      if (parsed.action === "terminate" && options.terminateStatus && options.terminateStatus >= 400) {
        return new Response(JSON.stringify({ error: { message: "nope" } }), { status: options.terminateStatus });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    calls.push({ kind: "other" });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CONNECT_EVENT = {
  callId: CALL_ID,
  callerPhone: "60123456789",
  status: "ringing" as const,
  direction: "inbound" as const,
  sdp: { type: "offer", sdp: OFFER_SDP },
  terminationReason: null,
  occurredAt: "2026-09-08T10:00:00.000Z",
};

function terminatedPayload(reason: string, nonce = "nonce-1"): GatewayCallbackPayload {
  return {
    event: "media_terminated",
    call_id: CALL_ID,
    session_id: "ms_test",
    timestamp: "2026-09-08T10:02:00.000Z",
    nonce,
    reason,
  } as GatewayCallbackPayload;
}

const ANSWERED_SESSION = {
  id: "row-1",
  call_id: CALL_ID,
  status: "answered",
  gateway_session_id: "ms_test",
  meta_accepted_at: "2026-09-08T10:00:03.000Z",
  callback_nonces: [],
  agency_id: AGENCY,
  phone_number_id: PHONE_ID,
  stage_timings: { webhook_received_at: "2026-09-08T10:00:00.000Z" },
};

/* ------------------------------------------------------------------ */
/* 4. Timing integrity — first write wins                               */
/* ------------------------------------------------------------------ */

describe("timing anchors are first-write-wins", () => {
  it("CallTimeline.mark never moves an anchor", () => {
    let t = 0;
    const timeline = new CallTimeline(() => new Date(1_757_300_000_000 + t));
    const first = timeline.mark("webhook_received_at");
    t += 5_000;
    const second = timeline.mark("webhook_received_at");
    expect(second).toBe(first);
    expect(timeline.get("webhook_received_at")).toBe(first);
  });

  it("mergeCallTimings keeps the original anchors when a terminal webhook merges its own", () => {
    const existing = {
      webhook_received_at: "2026-09-08T10:00:00.000Z",
      tenant_resolved_at: "2026-09-08T10:00:00.050Z",
      meta_accept_completed_at: "2026-09-08T10:00:03.000Z",
      failure_reason: "ice_failed",
      post_accept_notify_outcome: "confirmed:started",
    };
    const merged = mergeCallTimings(existing, {
      // A terminal webhook 40s later carries its own receive/tenant marks.
      webhook_received_at: "2026-09-08T10:00:40.000Z",
      tenant_resolved_at: "2026-09-08T10:00:40.030Z",
      terminate_received_at: "2026-09-08T10:00:39.000Z",
      failure_reason: "terminated",
      post_accept_notify_outcome: "failed:late",
    });
    expect(merged.webhook_received_at).toBe(existing.webhook_received_at);
    expect(merged.tenant_resolved_at).toBe(existing.tenant_resolved_at);
    expect(merged.terminate_received_at).toBe("2026-09-08T10:00:39.000Z");
    expect(merged.failure_reason).toBe("ice_failed");
    expect(merged.post_accept_notify_outcome).toBe("confirmed:started");
    // Durations are computed from the ORIGINAL anchors.
    expect(merged.durations_ms?.["webhook_to_terminate"]).toBe(39_000);
    expect(merged.durations_ms?.["webhook_to_accept"]).toBe(3_000);
  });

  it("a terminal Meta webhook adds terminate_received_at without overwriting the ringing anchors", async () => {
    const { db, writes } = makeDb({
      session: { ...ANSWERED_SESSION, status: "answered" },
    });
    await processCallEvent({
      db,
      event: {
        ...CONNECT_EVENT,
        status: "terminated",
        sdp: null,
        terminationReason: "USER_HANGUP",
        occurredAt: "2026-09-08T10:01:00.000Z",
      } as any,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: metaFetch().impl,
    });
    const terminal = writes.find((w) => w.payload?.status === "terminated");
    expect(terminal?.payload.stage_timings.webhook_received_at).toBe("2026-09-08T10:00:00.000Z");
    expect(terminal?.payload.stage_timings.terminate_received_at).toBe("2026-09-08T10:01:00.000Z");
    expect(hasCallTimingMark(terminal?.payload.stage_timings, "terminate_received_at")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Post-accept notification — confirmed, not assumed                 */
/* ------------------------------------------------------------------ */

describe("post-accept notification outcome", () => {
  it("only started/duplicate greetings are confirmed", () => {
    expect(isGreetingConfirmed({ ok: true, greeting: "started" })).toBe(true);
    expect(isGreetingConfirmed({ ok: true, greeting: "duplicate" })).toBe(true);
    expect(isGreetingConfirmed({ ok: true, greeting: "closed" })).toBe(false);
    expect(isGreetingConfirmed({ ok: true, greeting: "disabled" })).toBe(false);
    expect(isGreetingConfirmed({ ok: false, reason: "gateway_http_503" })).toBe(false);
    expect(postAcceptNotifyOutcome({ ok: true, greeting: "started" })).toBe("confirmed:started");
    expect(postAcceptNotifyOutcome({ ok: true, greeting: "closed" })).toBe("unconfirmed:closed");
    expect(postAcceptNotifyOutcome({ ok: false, reason: "gateway_http_503" })).toBe("failed:gateway_http_503");
  });

  it("records post_accept_notified_at only when the gateway confirms the greeting", async () => {
    const confirmed = makeDb({});
    await processCallEvent({
      db: confirmed.db,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: metaFetch({ greeting: "started" }).impl,
    });
    const okTimings = confirmed.writes.map((w) => w.payload?.stage_timings).filter(Boolean).at(-1);
    expect(okTimings.post_accept_notified_at).toEqual(expect.any(String));
    expect(okTimings.post_accept_notify_outcome).toBe("confirmed:started");

    const unconfirmed = makeDb({});
    const outcome = await processCallEvent({
      db: unconfirmed.db,
      event: CONNECT_EVENT,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: metaFetch({ greeting: "closed" }).impl,
    });
    expect(outcome).toBe("meta_accepted");
    const closedTimings = unconfirmed.writes.map((w) => w.payload?.stage_timings).filter(Boolean).at(-1);
    expect(closedTimings.post_accept_notified_at).toBeUndefined();
    expect(closedTimings.post_accept_notify_outcome).toBe("unconfirmed:closed");
    // Still never `answered` on accept alone.
    expect(unconfirmed.writes.map((w) => w.payload?.status)).not.toContain("answered");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Graceful termination at Meta                                      */
/* ------------------------------------------------------------------ */

describe("graceful Meta terminate after conversation_complete", () => {
  it("classifies only RAIŌ's own completion as graceful", () => {
    expect(isGracefulCompletion("conversation_complete")).toBe(true);
    expect(isGracefulCompletion("conversation_complete:farewell")).toBe(true);
    expect(isGracefulCompletion("peer_disconnected")).toBe(false);
    expect(isGracefulCompletion("caller_terminated")).toBe(false);
    expect(isGracefulCompletion("ice_failed")).toBe(false);
    expect(isGracefulCompletion(null)).toBe(false);
  });

  it("shouldTerminateAtMeta requires terminated + graceful + Meta-accepted + no prior request", () => {
    const base = { meta_accepted_at: "2026-09-08T10:00:03.000Z", stage_timings: {} };
    expect(shouldTerminateAtMeta({ outcome: "terminated", reason: "conversation_complete", session: base })).toBe(true);
    expect(shouldTerminateAtMeta({ outcome: "failed", reason: "conversation_complete", session: base })).toBe(false);
    expect(shouldTerminateAtMeta({ outcome: "terminated", reason: "peer_disconnected", session: base })).toBe(false);
    expect(
      shouldTerminateAtMeta({
        outcome: "terminated",
        reason: "conversation_complete",
        session: { meta_accepted_at: null, stage_timings: {} },
      }),
    ).toBe(false);
    expect(
      shouldTerminateAtMeta({
        outcome: "terminated",
        reason: "conversation_complete",
        session: { ...base, stage_timings: { meta_terminate_requested_at: "2026-09-08T10:02:00.000Z" } },
      }),
    ).toBe(false);
  });

  it("metaTerminateCall sends the official terminate payload with no SDP", async () => {
    let seen: any = null;
    const impl = (async (_url: any, init?: any) => {
      seen = { headers: init?.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await metaTerminateCall({ phoneNumberId: PHONE_ID, accessToken: "meta-token", callId: CALL_ID, fetchImpl: impl });
    expect(result).toEqual({ ok: true });
    expect(seen.body).toEqual({ messaging_product: "whatsapp", call_id: CALL_ID, action: "terminate" });
    expect(seen.body.session).toBeUndefined();
    expect(seen.headers.Authorization).toBe("Bearer meta-token");
  });

  it("metaTerminateCall reports a non-2xx as a reason and never throws", async () => {
    const impl = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(
      metaTerminateCall({ phoneNumberId: PHONE_ID, accessToken: "meta-token", callId: CALL_ID, fetchImpl: impl }),
    ).resolves.toEqual({ ok: false, reason: "meta_terminate_http_400" });
    await expect(
      metaTerminateCall({ phoneNumberId: PHONE_ID, accessToken: "", callId: CALL_ID, fetchImpl: impl }),
    ).resolves.toEqual({ ok: false, reason: "meta_token_missing" });
  });

  it("issues exactly one Meta terminate for a graceful completion and records the outcome", async () => {
    const { db, writes, state } = makeDb({ session: { ...ANSWERED_SESSION } });
    const { impl, calls } = metaFetch();

    const first = await processGatewayCallback({ db, payload: terminatedPayload("conversation_complete"), fetchImpl: impl });
    expect(first).toEqual({ applied: true, outcome: "terminated" });
    expect(calls.filter((c) => c.kind === "meta_terminate")).toHaveLength(1);
    expect(calls.find((c) => c.kind === "meta_terminate")?.body).toEqual({
      messaging_product: "whatsapp",
      call_id: CALL_ID,
      action: "terminate",
    });

    // The request marker travels in the SAME transition write.
    const transition = writes.find((w) => w.payload?.status === "terminated");
    expect(transition?.payload.stage_timings.meta_terminate_requested_at).toEqual(expect.any(String));
    expect(transition?.payload.stage_timings.terminate_received_at).toBe("2026-09-08T10:02:00.000Z");
    expect(transition?.payload.stage_timings.failure_reason).toBe("conversation_complete");
    expect(transition?.payload.stage_timings.webhook_received_at).toBe("2026-09-08T10:00:00.000Z");

    const outcomeWrite = writes.at(-1);
    expect(outcomeWrite?.payload.stage_timings.meta_terminate_outcome).toBe("ok");
    expect(outcomeWrite?.payload.stage_timings.meta_terminate_completed_at).toEqual(expect.any(String));
    expect(outcomeWrite?.payload.status).toBeUndefined();

    // A duplicate delivery is rejected upstream — no second Meta request.
    state.session = { ...(state.session as any), callback_nonces: ["nonce-1"] };
    const second = await processGatewayCallback({ db, payload: terminatedPayload("conversation_complete", "nonce-2"), fetchImpl: impl });
    expect(second).toEqual({ applied: false, rejection: "session_terminal" });
    expect(calls.filter((c) => c.kind === "meta_terminate")).toHaveLength(1);
  });

  it("never terminates at Meta for a caller hang-up or media failure", async () => {
    const { db } = makeDb({ session: { ...ANSWERED_SESSION } });
    const { impl, calls } = metaFetch();
    await processGatewayCallback({ db, payload: terminatedPayload("peer_disconnected"), fetchImpl: impl });
    expect(calls.filter((c) => c.kind.startsWith("meta_"))).toHaveLength(0);
  });

  it("a Meta terminate failure is recorded as an outcome and never changes call state", async () => {
    const { db, writes, state } = makeDb({ session: { ...ANSWERED_SESSION } });
    const { impl } = metaFetch({ terminateStatus: 500 });
    const result = await processGatewayCallback({ db, payload: terminatedPayload("conversation_complete"), fetchImpl: impl });
    expect(result).toEqual({ applied: true, outcome: "terminated" });
    expect((state.session as any).status).toBe("terminated");
    expect(writes.at(-1)?.payload.stage_timings.meta_terminate_outcome).toBe("failed:meta_terminate_http_500");
  });

  it("skips the Meta terminate when the tenant token is missing, with an explicit outcome", async () => {
    const { db, writes } = makeDb({ session: { ...ANSWERED_SESSION }, config: { agency_id: AGENCY, access_token: null } });
    const { impl, calls } = metaFetch();
    await processGatewayCallback({ db, payload: terminatedPayload("conversation_complete"), fetchImpl: impl });
    expect(calls.filter((c) => c.kind === "meta_terminate")).toHaveLength(0);
    expect(writes.at(-1)?.payload.stage_timings.meta_terminate_outcome).toBe("skipped:meta_token_missing");
  });

  it("refuses tenant credentials that do not belong to the session's agency", async () => {
    const { db, writes } = makeDb({
      session: { ...ANSWERED_SESSION },
      config: { agency_id: "22222222-2222-2222-2222-222222222222", access_token: "other-token" },
    });
    const { impl, calls } = metaFetch();
    await processGatewayCallback({ db, payload: terminatedPayload("conversation_complete"), fetchImpl: impl });
    expect(calls.filter((c) => c.kind === "meta_terminate")).toHaveLength(0);
    expect(writes.at(-1)?.payload.stage_timings.meta_terminate_outcome).toBe("skipped:tenant_unresolved");
  });
});

/* ------------------------------------------------------------------ */
/* 1. Observable persistence                                            */
/* ------------------------------------------------------------------ */

describe("database errors on the call path are observable", () => {
  it("a failed callback transition write is surfaced as retryable instead of silently applied", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = makeDb({
      session: { ...ANSWERED_SESSION },
      failUpdates: { table: "whatsapp_call_sessions", code: "23514" },
    });
    await expect(
      processGatewayCallback({ db, payload: terminatedPayload("peer_disconnected"), fetchImpl: metaFetch().impl }),
    ).rejects.toThrow("session_write_failed");
    expect(error.mock.calls.some((c) => String(c[0]).includes("session_write_failed") && String(c[0]).includes("code=23514"))).toBe(true);
    error.mockRestore();
  });

  it("a failed terminal webhook write is logged with stage and code and the webhook still completes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = makeDb({
      session: { ...ANSWERED_SESSION },
      failUpdates: { table: "whatsapp_call_sessions", code: "23514" },
    });
    const outcome = await processCallEvent({
      db,
      event: { ...CONNECT_EVENT, status: "terminated", sdp: null, terminationReason: "USER_HANGUP" } as any,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: metaFetch().impl,
    });
    expect(outcome).toBe("state_updated");
    const lines = error.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("session_write_failed") && l.includes("stage=webhook_terminated") && l.includes("attempt=2/2"))).toBe(true);
    error.mockRestore();
  });

  it("persistCallMemory writes the widened modality/status and reports every outcome", async () => {
    const inserted = makeDb({});
    await expect(
      persistCallMemory(inserted.db, { agencyId: AGENCY, conversationId: "conv-1", summary: "Ringkasan", callId: CALL_ID }),
    ).resolves.toBe("inserted");
    const row = inserted.writes.find((w) => w.table === "messages" && w.op === "insert")?.payload;
    expect(row).toMatchObject({ sender: "ai", modality: CALL_MEMORY_MODALITY, delivery_status: CALL_MEMORY_DELIVERY_STATUS });
    expect(CALL_MEMORY_MODALITY).toBe("call_summary");
    expect(CALL_MEMORY_DELIVERY_STATUS).toBe("internal");

    const updated = makeDb({ existingMemoryId: "msg-9" });
    await expect(
      persistCallMemory(updated.db, { agencyId: AGENCY, conversationId: "conv-1", summary: "Ringkasan 2", callId: CALL_ID }),
    ).resolves.toBe("updated");
    expect(updated.writes.filter((w) => w.table === "messages" && w.op === "insert")).toHaveLength(0);

    await expect(persistCallMemory(updated.db, { agencyId: AGENCY, conversationId: null, summary: "x" })).resolves.toBe(
      "skipped_no_conversation",
    );
  });

  it("a rejected call-memory insert is logged (code only) and returned, never thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = makeDb({ failInserts: { table: "messages", code: "23514" } });
    await expect(
      persistCallMemory(db, { agencyId: AGENCY, conversationId: "conv-1", summary: "Nama: Dato' Ryzal", callId: CALL_ID }),
    ).resolves.toBe("insert_failed");
    const line = error.mock.calls.map((c) => String(c[0])).find((l) => l.includes("call_memory_write_failed"));
    expect(line).toContain("stage=insert");
    expect(line).toContain("code=23514");
    expect(line).not.toContain("Ryzal");
    error.mockRestore();
  });

  it("finalizeCallMemory reports the persisted outcome and the terminal webhook records a failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, writes } = makeDb({
      session: { ...ANSWERED_SESSION, conversation_id: "conv-1", call_summary: "Ringkasan" },
      failInserts: { table: "messages", code: "42501" },
    });
    await expect(finalizeCallMemory(db, { callId: CALL_ID })).resolves.toBe("insert_failed");

    await processCallEvent({
      db,
      event: { ...CONNECT_EVENT, status: "terminated", sdp: null, terminationReason: "USER_HANGUP" } as any,
      phoneNumberId: PHONE_ID,
      env: ENV,
      fetchImpl: metaFetch().impl,
    });
    const recorded = writes.map((w) => w.payload?.stage_timings?.call_memory_outcome).filter(Boolean);
    expect(recorded).toContain("insert_failed");
    error.mockRestore();
  });
});

/* ------------------------------------------------------------------ */
/* Rendering / metrics / provider classification                        */
/* ------------------------------------------------------------------ */

describe("call_summary compatibility", () => {
  it("renders as an ordinary text bubble, never as unknown media", () => {
    expect(mediaKindOf("call_summary")).toBe("text");
    expect(mediaKindOf("text")).toBe("text");
    expect(mediaKindOf("audio")).toBe("audio");
    expect(mediaKindOf("sticker")).toBe("unknown");
  });
});

describe("MiniMax status classification", () => {
  it("treats 2053 (insufficient credit) as an entitlement failure, like 1008", () => {
    expect(MINIMAX_ENTITLEMENT_CODES.has(2053)).toBe(true);
    expect(classifyMinimaxStatusCode(2053)).toBe("entitlement");
    expect(classifyMinimaxStatusCode(1008)).toBe("entitlement");
    expect(classifyMinimaxStatusCode(1004)).toBe("unauthorized");
    expect(classifyMinimaxStatusCode(2049)).toBe("unauthorized");
    expect(classifyMinimaxStatusCode(1002)).toBe("rate_limited");
    expect(classifyMinimaxStatusCode(9999)).toBe("provider");
  });
});
