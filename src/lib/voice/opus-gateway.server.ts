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

/** A real OGG/Opus file starts with an "OggS" page carrying "OpusHead". */
export function looksLikeOggOpus(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 47) return false;
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== "OggS") return false;
  const head = String.fromCharCode(...bytes.subarray(28, 36));
  return head === "OpusHead";
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
  if (!pcm || pcm.byteLength < 2) return { ok: false, reason: "invalid_pcm" };
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
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "gateway_unavailable" };
  }

  if (!response.ok) return { ok: false, reason: `gateway_http_${response.status}` };

  const parsed = (await response.json().catch(() => null)) as { ogg_base64?: string } | null;
  const encoded = parsed?.ogg_base64?.trim();
  if (!encoded) return { ok: false, reason: "gateway_invalid_response" };

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encoded);
  } catch {
    return { ok: false, reason: "gateway_invalid_response" };
  }
  // Fail closed rather than hand Meta an attachment-shaped blob.
  if (!looksLikeOggOpus(bytes)) return { ok: false, reason: "gateway_invalid_container" };

  return { ok: true, bytes };
}
