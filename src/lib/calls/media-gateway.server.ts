/**
 * UMRAIO® — outbound control-plane -> media-gateway client (server only).
 *
 * The Worker is the only party that talks to this service. Every request is
 * signed twice: a request-level HMAC over "<ts>.<body>" and a single-call
 * bearer session token. Nothing secret ever crosses this boundary.
 */
import {
  GATEWAY_SIGNATURE_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  mintVoiceGatewaySessionToken,
  signGatewayRequest,
} from "./gateway-auth.core";

export type GatewayEnv = Record<string, string | undefined>;

export type MediaSessionRequest = {
  gatewayUrl: string;
  secret: string;
  callId: string;
  agencyId: string;
  phoneNumberId: string;
  /** The REAL SDP offer Meta sent on the `connect` event. Never synthesised. */
  sdpOffer: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type MediaSessionResult =
  | { ok: true; sessionId: string; sdpAnswer: string; state: string }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Asks the gateway to terminate the Meta offer and produce a REAL SDP answer.
 * A non-2xx or malformed reply is a hard failure: we never invent an answer.
 */
export async function requestMediaSession(args: MediaSessionRequest): Promise<MediaSessionResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const now = args.now ?? new Date();

  if (!args.gatewayUrl) return { ok: false, reason: "gateway_not_configured" };
  if (!args.secret) return { ok: false, reason: "gateway_secret_missing" };
  if (!args.sdpOffer?.trim()) return { ok: false, reason: "missing_remote_sdp" };

  let token: string;
  try {
    ({ token } = await mintVoiceGatewaySessionToken({
      secret: args.secret,
      callId: args.callId,
      agencyId: args.agencyId,
      phoneNumberId: args.phoneNumberId,
      now,
    }));
  } catch {
    return { ok: false, reason: "session_token_mint_failed" };
  }

  const body = JSON.stringify({ call_id: args.callId, sdp_offer: args.sdpOffer, sdp_type: "offer" });
  const ts = Math.floor(now.getTime() / 1000);
  const signature = await signGatewayRequest(args.secret, ts, body);

  let response: Response;
  try {
    response = await doFetch(`${normalizeBase(args.gatewayUrl)}/v1/calls/offer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        [GATEWAY_TIMESTAMP_HEADER]: String(ts),
        [GATEWAY_SIGNATURE_HEADER]: signature,
      },
      body,
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "gateway_unavailable" };
  }

  if (!response.ok) return { ok: false, reason: `gateway_http_${response.status}` };

  const parsed = (await response.json().catch(() => null)) as
    | { session_id?: string; sdp_answer?: string; state?: string }
    | null;
  const sessionId = parsed?.session_id?.trim();
  // Forward the answer byte-for-byte: RFC 4566 requires the final line to keep
  // its terminator, and Meta rejects an accept whose SDP differs from the
  // pre_accept SDP. Validate on a trimmed COPY only.
  const sdpAnswer = parsed?.sdp_answer;
  if (!sessionId || !sdpAnswer || !sdpAnswer.trim()) {
    return { ok: false, reason: "gateway_invalid_response" };
  }

  return { ok: true, sessionId, sdpAnswer, state: parsed?.state?.trim() || "media_negotiating" };
}

/** Best-effort media teardown. Failure here never changes business call state. */
export async function terminateMediaSession(args: {
  gatewayUrl: string;
  secret: string;
  callId: string;
  agencyId: string;
  phoneNumberId: string;
  reason: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const doFetch = args.fetchImpl ?? fetch;
  const now = args.now ?? new Date();
  if (!args.gatewayUrl || !args.secret) return { ok: false, reason: "gateway_not_configured" };

  try {
    const { token } = await mintVoiceGatewaySessionToken({
      secret: args.secret,
      callId: args.callId,
      agencyId: args.agencyId,
      phoneNumberId: args.phoneNumberId,
      now,
    });
    const body = JSON.stringify({ reason: args.reason });
    const ts = Math.floor(now.getTime() / 1000);
    const response = await doFetch(
      `${normalizeBase(args.gatewayUrl)}/v1/calls/${encodeURIComponent(args.callId)}/terminate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          [GATEWAY_TIMESTAMP_HEADER]: String(ts),
          [GATEWAY_SIGNATURE_HEADER]: await signGatewayRequest(args.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
    return response.ok ? { ok: true } : { ok: false, reason: `gateway_http_${response.status}` };
  } catch {
    return { ok: false, reason: "gateway_unavailable" };
  }
}

/**
 * Explicit "Meta accept completed" signal.
 *
 * Until this lands the gateway stays silent by design: any turn attempted
 * before Meta accept is rejected by the control plane (`not_accepted`) and is
 * never retried, so nothing would ever produce the first outbound RTP packet.
 * The gateway treats this as idempotent — a repeat yields `duplicate`.
 * Failure here never changes business call state.
 */
export async function notifyCallAccepted(args: {
  gatewayUrl: string;
  secret: string;
  callId: string;
  agencyId: string;
  phoneNumberId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; greeting?: string; reason?: string }> {
  const doFetch = args.fetchImpl ?? fetch;
  const now = args.now ?? new Date();
  if (!args.gatewayUrl || !args.secret) return { ok: false, reason: "gateway_not_configured" };

  try {
    const { token } = await mintVoiceGatewaySessionToken({
      secret: args.secret,
      callId: args.callId,
      agencyId: args.agencyId,
      phoneNumberId: args.phoneNumberId,
      now,
    });
    const body = JSON.stringify({ event: "meta_accepted" });
    const ts = Math.floor(now.getTime() / 1000);
    const response = await doFetch(
      `${normalizeBase(args.gatewayUrl)}/v1/calls/${encodeURIComponent(args.callId)}/accepted`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          [GATEWAY_TIMESTAMP_HEADER]: String(ts),
          [GATEWAY_SIGNATURE_HEADER]: await signGatewayRequest(args.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
    if (!response.ok) return { ok: false, reason: `gateway_http_${response.status}` };
    const parsed = (await response.json().catch(() => null)) as { greeting?: string } | null;
    return { ok: true, greeting: parsed?.greeting ?? "unknown" };
  } catch {
    return { ok: false, reason: "gateway_unavailable" };
  }
}

export function resolveGatewayConfig(env: GatewayEnv): { url: string; secret: string } | null {
  const url = env["WHATSAPP_MEDIA_GATEWAY_URL"]?.trim();
  const secret = env["WHATSAPP_MEDIA_GATEWAY_SECRET"]?.trim();
  if (!url || !secret) return null;
  return { url, secret };
}
