/**
 * UMRAIO® VOICE — media-plane Opus encoding for WhatsApp voice notes.
 *
 * WHY: in the published serverless runtime, compiling WebAssembly from bytes is
 * rejected by the embedder ("Wasm code generation disallowed by embedder"), so
 * the in-Worker libopus build cannot run there on the normal voice-note path.
 * (A hosted precompiled-module loader has not been independently validated on
 * this platform either way; the only verified evidence is the byte-compilation
 * rejection.) The Go media gateway already links NATIVE libopus for calls, so
 * the same validated MiniMax PCM is encoded there and returned as OGG/Opus.
 *
 * Nothing about the voice identity changes: same MiniMax model, same voice,
 * same s16le / 24 kHz / mono PCM, same native OGG/Opus delivery, and the same
 * fail-closed policy when encoding is unavailable.
 *
 * Everything crossing this boundary is untrusted peer input: no function here
 * may throw on a malformed or hostile response, and nothing is buffered without
 * a hard byte bound.
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

/** Bound the response so a misbehaving peer cannot exhaust Worker memory. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** ~120 s of s16le / 24 kHz / mono; the media plane rejects more than this. */
const MAX_PCM_BYTES = 24000 * 2 * 120;

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

/* ------------------------------------------------------------------ *
 * OGG/Opus structural validation
 * ------------------------------------------------------------------ */

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    // Bytes 22..25 hold the checksum itself and are treated as zero.
    const b = i >= 22 && i <= 25 ? 0 : page[i]!;
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

function ascii(bytes: Uint8Array, from: number, length: number): string {
  if (from < 0 || from + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(from, from + length));
}

function readU32LE(bytes: Uint8Array, at: number): number | null {
  if (at < 0 || at + 4 > bytes.byteLength) return null;
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

/**
 * Full structural validation of a complete single-stream OGG/Opus file. Every
 * offset is bounds-checked before it is read, so a truncated or adversarial
 * blob returns false instead of throwing.
 */
export function looksLikeOggOpus(bytes: Uint8Array): boolean {
  if (!bytes || bytes.byteLength < 100) return false;

  let offset = 0;
  let pageIndex = 0;
  let serial: number | null = null;
  let audioPages = 0;
  let sawHead = false;
  let sawTags = false;
  let sawEos = false;

  while (offset < bytes.byteLength) {
    if (offset + 27 > bytes.byteLength) return false;
    if (ascii(bytes, offset, 4) !== "OggS") return false;
    if (bytes[offset + 4] !== 0) return false; // stream structure version

    const headerType = bytes[offset + 5]!;
    if ((headerType & 0xf8) !== 0) return false; // reserved bits
    const pageSerial = readU32LE(bytes, offset + 14);
    const pageSeq = readU32LE(bytes, offset + 18);
    const storedCrc = readU32LE(bytes, offset + 22);
    if (pageSerial === null || pageSeq === null || storedCrc === null) return false;

    if (pageIndex === 0) serial = pageSerial;
    else if (pageSerial !== serial) return false;
    if (pageSeq !== pageIndex) return false;

    const segments = bytes[offset + 26]!;
    const headerLength = 27 + segments;
    if (offset + headerLength > bytes.byteLength) return false;
    let payloadLength = 0;
    for (let i = 0; i < segments; i++) payloadLength += bytes[offset + 27 + i]!;
    const end = offset + headerLength + payloadLength;
    if (end > bytes.byteLength) return false;

    if (oggCrc(bytes.subarray(offset, end)) !== storedCrc) return false;

    const isBos = (headerType & 0x02) !== 0;
    const isEos = (headerType & 0x04) !== 0;
    if (isBos !== (pageIndex === 0)) return false; // BOS only on the first page
    if (sawEos) return false; // nothing may follow the EOS page
    if (isEos) sawEos = true;

    const payload = bytes.subarray(offset + headerLength, end);
    if (pageIndex === 0) {
      // OpusHead: 19 bytes, version 1, mono, sane rate, mapping family 0.
      if (payload.byteLength < 19) return false;
      if (ascii(payload, 0, 8) !== "OpusHead") return false;
      if (payload[8] !== 1) return false;
      if (payload[9] !== 1) return false; // voice notes are mono
      const rate = readU32LE(payload, 12);
      if (rate === null || rate < 8000 || rate > 48000) return false;
      if (payload[18] !== 0) return false; // channel mapping family
      sawHead = true;
    } else if (pageIndex === 1) {
      // OpusTags: magic, vendor string, then a complete comment list.
      if (payload.byteLength < 16) return false;
      if (ascii(payload, 0, 8) !== "OpusTags") return false;
      const vendorLength = readU32LE(payload, 8);
      if (vendorLength === null || 12 + vendorLength + 4 > payload.byteLength) return false;
      let cursor = 12 + vendorLength;
      const count = readU32LE(payload, cursor);
      if (count === null) return false;
      cursor += 4;
      for (let i = 0; i < count; i++) {
        const length = readU32LE(payload, cursor);
        if (length === null) return false;
        cursor += 4 + length;
        if (cursor > payload.byteLength) return false;
      }
      if (cursor > payload.byteLength) return false;
      sawTags = true;
    } else if (payloadLength > 0) {
      audioPages += 1;
    }

    offset = end;
    pageIndex += 1;
  }

  return sawHead && sawTags && sawEos && audioPages > 0 && offset === bytes.byteLength;
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/** Read a response body with a hard byte bound applied WHILE streaming. */
async function readBoundedText(response: Response, max: number): Promise<string | null> {
  const body = response.body;
  if (!body) {
    // No stream available (test doubles): fall back, still bounded after read.
    const text = await response.text();
    return text.length > max ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock?.();
  }
  return text + decoder.decode();
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
  // Bound BEFORE base64 expansion and signing: never allocate on peer scale.
  if (pcm.byteLength > MAX_PCM_BYTES) return { ok: false, reason: "pcm_too_large" };
  if (!args.gatewayUrl || !args.secret) return { ok: false, reason: "gateway_not_configured" };

  const doFetch = args.fetchImpl ?? fetch;
  const now = args.now ?? new Date();
  const body = JSON.stringify({ pcm_base64: bytesToBase64(pcm) });
  const ts = Math.floor(now.getTime() / 1000);
  // One deadline covers the request AND the body read.
  const signal = AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
      // A signed body must never be replayed to a redirect target. Workers only
      // support "follow" | "manual", so redirects are surfaced and rejected below.
      redirect: "manual",
      signal,
    });
  } catch (e) {
    // Sanitized transport diagnostics only: never the body, signature or secret.
    console.error(
      `[voice] opus_gateway_transport_error class=${(e as Error)?.name ?? "unknown"} detail=${String((e as Error)?.message ?? "").slice(0, 120)}`,
    );
    return { ok: false, reason: "gateway_unavailable" };
  }

  if (response.status >= 300 && response.status < 400) {
    return { ok: false, reason: "gateway_redirect_rejected" };
  }
  if (!response.ok) return { ok: false, reason: `gateway_http_${response.status}` };

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    return { ok: false, reason: "gateway_response_too_large" };
  }

  let text: string | null;
  try {
    text = await readBoundedText(response, MAX_RESPONSE_BYTES);
  } catch (e) {
    const aborted = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    return { ok: false, reason: aborted ? "gateway_timeout" : "gateway_unavailable" };
  }
  if (text === null) return { ok: false, reason: "gateway_response_too_large" };

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

/**
 * Loopback-only guard for the public diagnostics probe: a probe request must be
 * incapable of reaching the real media plane, even if the opt-in flag is set by
 * accident in a hosted environment.
 */
export function isLoopbackGatewayUrl(gatewayUrl: string | undefined | null): boolean {
  if (!gatewayUrl) return false;
  let url: URL;
  try {
    url = new URL(gatewayUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}
