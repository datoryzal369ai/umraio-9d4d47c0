/**
 * UMRAIO® — control plane <-> media gateway authentication (pure core).
 *
 * Mirrors, byte for byte, the Go contract in `voice-gateway/internal/auth`:
 *   - session token  = base64url(JSON claims) + "." + base64url(HMAC-SHA256)
 *   - request HMAC   = "v1=" + hex(HMAC-SHA256(secret, "<unixTs>.<rawBody>"))
 *
 * SECURITY: the token is single-call scoped and carries NO credentials — no
 * Meta access token, no Supabase key, no ASR/TTS key. The shared secret is a
 * server-only value and must never reach browser code.
 */

export const GATEWAY_TOKEN_SCOPE = "voice.media";
export const GATEWAY_SIGNATURE_HEADER = "X-Umraio-Signature";
export const GATEWAY_TIMESTAMP_HEADER = "X-Umraio-Timestamp";

/** Hard ceiling enforced by the gateway (auth.MaxTokenLifetime). */
export const MAX_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
/** What we actually mint: a call is negotiated in seconds, not minutes. */
export const DEFAULT_TOKEN_LIFETIME_MS = 90 * 1000;
/** Mirrors auth.MaxRequestSkew. */
export const MAX_REQUEST_SKEW_MS = 5 * 60 * 1000;

export type GatewaySessionClaims = {
  call_id: string;
  agency_id: string;
  phone_number_id: string;
  iat: number;
  exp: number;
  nonce: string;
  scope: string;
};

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Length-independent, content constant-time comparison. */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Mints the short-lived, single-call session token the gateway expects as
 * `Authorization: Bearer <token>`.
 */
export async function mintVoiceGatewaySessionToken(args: {
  secret: string;
  callId: string;
  agencyId: string;
  phoneNumberId: string;
  now?: Date;
  ttlMs?: number;
  nonce?: string;
}): Promise<{ token: string; claims: GatewaySessionClaims }> {
  const { secret, callId, agencyId, phoneNumberId } = args;
  if (!secret) throw new Error("gateway_secret_missing");
  if (!callId || !agencyId || !phoneNumberId) throw new Error("gateway_token_missing_claim");

  const ttl = Math.min(args.ttlMs ?? DEFAULT_TOKEN_LIFETIME_MS, MAX_TOKEN_LIFETIME_MS);
  if (ttl <= 0) throw new Error("gateway_token_invalid_ttl");
  const nowMs = (args.now ?? new Date()).getTime();

  const claims: GatewaySessionClaims = {
    call_id: callId,
    agency_id: agencyId,
    phone_number_id: phoneNumberId,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + ttl) / 1000),
    nonce: args.nonce ?? newNonce(),
    scope: GATEWAY_TOKEN_SCOPE,
  };

  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = toBase64Url(await hmacSha256(secret, payload));
  return { token: `${payload}.${signature}`, claims };
}

/** Value for `X-Umraio-Signature` over "<unixSeconds>.<rawBody>". */
export async function signGatewayRequest(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): Promise<string> {
  if (!secret) throw new Error("gateway_secret_missing");
  return `v1=${toHex(await hmacSha256(secret, `${timestampSeconds}.${rawBody}`))}`;
}

export type CallbackSignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale_request" | "bad_signature" | "no_secret" };

/**
 * Verifies an inbound gateway callback. Signature is checked over the RAW body
 * bytes exactly as received — never over a re-serialised object.
 */
export async function verifyGatewayCallbackSignature(args: {
  secret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  now?: Date;
}): Promise<CallbackSignatureResult> {
  if (!args.secret) return { ok: false, reason: "no_secret" };
  if (!args.signature || !args.timestamp) return { ok: false, reason: "missing_headers" };

  const ts = Number.parseInt(args.timestamp.trim(), 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };

  const nowMs = (args.now ?? new Date()).getTime();
  if (Math.abs(nowMs - ts * 1000) > MAX_REQUEST_SKEW_MS) return { ok: false, reason: "stale_request" };

  const expected = await signGatewayRequest(args.secret, ts, args.rawBody);
  if (!timingSafeEqualString(args.signature.trim(), expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
