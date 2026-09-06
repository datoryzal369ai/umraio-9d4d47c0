/**
 * UMRAIO® — media-gateway callback decision core (pure, deterministic).
 *
 * The gateway is a dumb media terminator. It asserts nothing about tenancy or
 * business truth: this module correlates its event to the Worker's own call
 * session row and decides what — if anything — may be written.
 *
 * THE ANSWERED RULE lives here and nowhere else:
 *   answered  <=>  Meta accept already succeeded (meta_accepted_at persisted)
 *                  AND the gateway reported real bidirectional media
 *                  AND call_id matches
 *                  AND gateway_session_id matches
 *                  AND the session is not terminal.
 */

export const GATEWAY_CALLBACK_EVENTS = [
  "media_ready",
  "media_terminated",
  "media_failed",
  // Informational lifecycle only. NEVER implies media readiness or "answered".
  "media_negotiating",
] as const;
export type GatewayCallbackEvent = (typeof GATEWAY_CALLBACK_EVENTS)[number];

/** Bounded per-call replay ledger. A call cannot legitimately emit more. */
export const MAX_CALLBACK_NONCES = 32;

export type GatewayCallbackPayload = {
  event: GatewayCallbackEvent;
  call_id: string;
  session_id: string;
  timestamp: string;
  nonce: string;
  reason?: string;
  inbound_packets?: number;
  outbound_packets?: number;
};

export type CallSessionRow = {
  id: string;
  call_id: string;
  status: string;
  gateway_session_id: string | null;
  meta_accepted_at: string | null;
  callback_nonces: string[] | null;
};

export type CallbackRejection =
  | "invalid_payload"
  | "unsupported_event"
  | "unknown_call"
  | "call_id_mismatch"
  | "gateway_session_mismatch"
  | "replayed_nonce"
  | "session_terminal"
  | "media_ready_without_meta_accept"
  | "duplicate_event";

export type CallbackDecision =
  | { apply: false; rejection: CallbackRejection }
  | {
      apply: true;
      outcome: "answered" | "terminated" | "failed" | "negotiating";
      patch: Record<string, unknown>;
      /** Compare-and-set guard: only write when gateway_session_id is still NULL. */
      requireNullGatewaySession?: true;
    };

const TERMINAL = new Set(["missed", "terminated", "failed"]);

export function isTerminalSessionStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** Strictly validates the untrusted JSON body of a gateway callback. */
export function parseGatewayCallback(raw: unknown): GatewayCallbackPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof value[key] === "string" ? (value[key] as string).trim() : "");

  const event = str("event");
  if (!(GATEWAY_CALLBACK_EVENTS as readonly string[]).includes(event)) return null;

  const callId = str("call_id");
  const sessionId = str("session_id");
  const nonce = str("nonce");
  const timestamp = str("timestamp");
  if (!callId || !sessionId || !nonce || !timestamp) return null;
  if (callId.length > 256 || sessionId.length > 128 || nonce.length > 128) return null;

  const reason = str("reason");
  const num = (key: string): number | undefined =>
    typeof value[key] === "number" && Number.isFinite(value[key] as number) ? (value[key] as number) : undefined;

  const payload: GatewayCallbackPayload = {
    event: event as GatewayCallbackEvent,
    call_id: callId,
    session_id: sessionId,
    timestamp,
    nonce,
  };
  if (reason) payload.reason = reason.slice(0, 120);
  const inbound = num("inbound_packets");
  if (inbound !== undefined) payload.inbound_packets = inbound;
  const outbound = num("outbound_packets");
  if (outbound !== undefined) payload.outbound_packets = outbound;
  return payload;
}

export function appendCallbackNonce(existing: string[] | null, nonce: string): string[] {
  const list = [...(existing ?? []), nonce];
  return list.length > MAX_CALLBACK_NONCES ? list.slice(list.length - MAX_CALLBACK_NONCES) : list;
}

/**
 * Decides the single write (if any) a gateway callback may produce.
 * `session` is the row the Worker itself loaded by call_id — the gateway's
 * agency_id (which it does not even send) is never consulted.
 */
export function decideGatewayCallback(args: {
  payload: GatewayCallbackPayload;
  session: CallSessionRow | null;
  now: Date;
}): CallbackDecision {
  const { payload, session, now } = args;
  if (!session) return { apply: false, rejection: "unknown_call" };
  if (session.call_id !== payload.call_id) return { apply: false, rejection: "call_id_mismatch" };

  if ((session.callback_nonces ?? []).includes(payload.nonce)) {
    return { apply: false, rejection: "replayed_nonce" };
  }
  const storedSession = (session.gateway_session_id ?? "").trim();
  const negotiating = payload.event === "media_negotiating";
  // media_negotiating may legitimately race ahead of the control plane's own
  // persistence of gateway_session_id. It may bind a NULL value, never replace one.
  const mayBind = negotiating && storedSession === "";
  if (!mayBind && (!storedSession || storedSession !== payload.session_id)) {
    return { apply: false, rejection: "gateway_session_mismatch" };
  }

  const nowIso = now.toISOString();
  const nonces = appendCallbackNonce(session.callback_nonces, payload.nonce);

  if (negotiating) {
    if (isTerminalSessionStatus(session.status)) return { apply: false, rejection: "session_terminal" };
    // Purely informational: it must never move status toward answered/media_ready.
    const patch: Record<string, unknown> = { callback_nonces: nonces };
    if (mayBind) patch["gateway_session_id"] = payload.session_id;
    return mayBind
      ? { apply: true, outcome: "negotiating", patch, requireNullGatewaySession: true }
      : { apply: true, outcome: "negotiating", patch };
  }


  if (payload.event === "media_ready") {
    if (isTerminalSessionStatus(session.status)) return { apply: false, rejection: "session_terminal" };
    if (session.status === "answered") return { apply: false, rejection: "duplicate_event" };
    // The rule: no Meta accept, no answer. Ever.
    if (!session.meta_accepted_at) return { apply: false, rejection: "media_ready_without_meta_accept" };
    return {
      apply: true,
      outcome: "answered",
      patch: { status: "answered", answered_at: nowIso, media_ready_at: nowIso, callback_nonces: nonces },
    };
  }

  // media_terminated / media_failed
  if (isTerminalSessionStatus(session.status)) return { apply: false, rejection: "session_terminal" };
  const failed = payload.event === "media_failed";
  return {
    apply: true,
    outcome: failed ? "failed" : "terminated",
    patch: {
      status: failed ? "failed" : "terminated",
      ended_at: nowIso,
      termination_reason: (payload.reason || payload.event).slice(0, 120),
      callback_nonces: nonces,
    },
  };
}
