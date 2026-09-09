/**
 * UMRAIO® VOICE — media-plane Opus encoding for WhatsApp voice notes.
 *
 * WHY: the published serverless runtime forbids compiling WebAssembly from
 * bytes ("Wasm code generation disallowed by embedder") and the fetch-bundle
 * deployment has no loader for a precompiled `.wasm` module, so the in-Worker
 * libopus build can never run in production. The Go media gateway already
 * links NATIVE libopus for calls, so the same validated MiniMax PCM is encoded
 * there and returned as a complete OGG/Opus file.
 *
 * Nothing about the voice identity changes: same MiniMax model, same voice,
 * same s16le / 24 kHz / mono PCM, same native OGG/Opus delivery, and the same
 * fail-closed policy when encoding is unavailable.
 */
import {
  GATEWAY_SIGNATURE_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  signGatewayRequest,
} from "@/lib/calls/gateway-auth.core";

export type GatewayOpusResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

/** Encoding a ~60 s voice note takes well under this; it is a safety net only. */
const DEFAULT_TIMEOUT_MS = 30_000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Bound the response so a misbehaving peer cannot exhaust Worker memory. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Structural validation of a complete OGG/Opus file: first page is a BOS page
 * carrying OpusHead with a sane channel count and rate, the second packet is
 * OpusTags, and at least one audio page follows. A 47-byte prefix check would
 * happily pass a truncated or header-only blob.
 */
export function looksLikeOggOpus(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 100) return false;
  const text = (from: number, length: number) =>
    String.fromCharCode(...bytes.subarray(from, from + length));
  if (text(0, 4) !== "OggS" || bytes[4] !== 0) return false;
  if ((bytes[5]! & 0x02) === 0) return false; // BOS
  const firstSegments = bytes[26]!;
  const firstPayload = 27 + firstSegments;
  if (text(firstPayload, 8) !== "OpusHead") return false;
  const channels = bytes[firstPayload + 9]!;
  if (channels < 1 || channels > 2) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const rate = view.getUint32(firstPayload + 12, true);
  if (rate < 8000 || rate > 48000) return false;

  // Walk the remaining pages: they must be well formed, OpusTags must be the
  // second packet, an EOS page must close the stream and audio must exist.
  let offset = firstPayload + bytes.subarray(27, 27 + firstSegments).reduce((a, b) => a + b, 0);
  let pageIndex = 1;
  let audioPages = 0;
  let sawTags = false;
  let sawEos = false;
  while (offset < bytes.byteLength) {
    if (offset + 27 > bytes.byteLength || text(offset, 4) !== "OggS") return false;
    const segments = bytes[offset + 26]!;
    const headerLength = 27 + segments;
    if (offset + headerLength > bytes.byteLength) return false;
    const payloadLength = bytes
      .subarray(offset + 27, offset + headerLength)
      .reduce((a, b) => a + b, 0);
    const end = offset + headerLength + payloadLength;
    if (end > bytes.byteLength) return false;
    if (pageIndex === 1 && text(offset + headerLength, 8) !== "OpusTags") return false;
    if (pageIndex === 1) sawTags = true;
    else if (payloadLength > 0) audioPages += 1;
    if ((bytes[offset + 5]! & 0x04) !== 0) sawEos = true;
    offset = end;
    pageIndex += 1;
  }
  return sawTags && sawEos && audioPages > 0 && offset === bytes.byteLength;
}

export async function encodeOggOpusViaGateway(
  pcm: Uint8Array,
  args: {
    gatewayUrl: string;
    secret: string;
    now?: Date;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<GatewayOpusResult> {
  if (!pcm || pcm.byteLength < 2 || pcm.byteLength % 2 !== 0) {
    return { ok: false, reason: "invalid_pcm" };
  }
  if (!args.gatewayUrl || !args.secret) return { ok: false, reason: "gateway_not_configured" };

  const doFetch = args.fetchImpl ?? fetch;
  const now = args.now ?? new Date();
  const body = JSON.stringify({ pcm_base64: bytesToBase64(pcm) });
  const ts = Math.floor(now.getTime() / 1000);

  let response: Response;
  try {
    response = await doFetch(`${args.gatewayUrl.trim().replace(/\/+$/, "")}/v1/audio/opus`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [GATEWAY_TIMESTAMP_HEADER]: String(ts),
        [GATEWAY_SIGNATURE_HEADER]: await signGatewayRequest(args.secret, ts, body),
      },
      body,
      // A signed body must never be replayed to a redirect target.
      redirect: "error",
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    // Sanitized transport diagnostics only: never the body, signature or secret.
    console.error(
      `[voice] opus_gateway_transport_error class=${(e as Error)?.name ?? "unknown"} detail=${String((e as Error)?.message ?? "").slice(0, 120)}`,
    );
    return { ok: false, reason: "gateway_unavailable" };
  }

  if (!response.ok) return { ok: false, reason: `gateway_http_${response.status}` };

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) return { ok: false, reason: "gateway_response_too_large" };

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: "gateway_unavailable" };
  }
  if (text.length > MAX_RESPONSE_BYTES) return { ok: false, reason: "gateway_response_too_large" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "gateway_invalid_response" };
  }
  const raw = (parsed as { ogg_base64?: unknown } | null)?.ogg_base64;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "gateway_invalid_response" };
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(raw.trim());
  } catch {
    return { ok: false, reason: "gateway_invalid_response" };
  }
  // Fail closed rather than hand Meta an attachment-shaped blob.
  if (!looksLikeOggOpus(bytes)) return { ok: false, reason: "gateway_invalid_container" };

  return { ok: true, bytes };
}

/** Server-only binding names, shared with the calling control plane. */
export function resolveOpusGatewayConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { gatewayUrl: string; secret: string } | null {
  const gatewayUrl = env["WHATSAPP_MEDIA_GATEWAY_URL"]?.trim();
  const secret = env["WHATSAPP_MEDIA_GATEWAY_SECRET"]?.trim();
  if (!gatewayUrl || !secret) return null;
  return { gatewayUrl, secret };
}

