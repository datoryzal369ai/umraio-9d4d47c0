/**
 * UMRAIO® VOICE — the single PCM → OGG/Opus entry point for RAIŌ audio replies.
 *
 * ORDER OF ENCODERS
 *   1. native_gateway — the Go media plane links real libopus. This is the ONLY
 *      encoder that works in the published Worker runtime, where compiling
 *      WebAssembly from bytes is rejected by the embedder.
 *   2. local WASM     — dev/test/CI only, where byte compilation is allowed and
 *      no media gateway is configured.
 *
 * Everything else is unchanged: MiniMax speech-2.8-hd, Malay_male_1_v1, s16le
 * 24 kHz mono in, native OGG/Opus out, and fail-closed when encoding fails —
 * there is no MP3 or other-provider substitute for a true voice note.
 */
import { encodeOggOpusViaGateway, resolveOpusGatewayConfig } from "./opus-gateway.server";

export type VoiceNoteEncodeResult =
  | { ok: true; bytes: Uint8Array; source: "native_gateway" | "local_wasm" }
  | { ok: false; reason: string; source: "native_gateway" | "local_wasm" | "unavailable" };

/** ~120 s of s16le / 24 kHz / mono — the media plane rejects more than this. */
export const MAX_VOICE_NOTE_PCM_BYTES = 24000 * 2 * 120;

export async function encodeVoiceNotePcm(
  pcm: Uint8Array,
  overrides?: Record<string, string | undefined>,
): Promise<VoiceNoteEncodeResult> {
  // Read bindings key by key at call time: the Worker runtime injects them
  // per request, so a captured process.env reference can come back empty.
  const env: Record<string, string | undefined> = overrides ?? {
    NODE_ENV: process.env["NODE_ENV"],
    WHATSAPP_MEDIA_GATEWAY_URL: process.env["WHATSAPP_MEDIA_GATEWAY_URL"],
    WHATSAPP_MEDIA_GATEWAY_SECRET: process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"],
  };

  // Validate at the entry point, before any encoder is selected or reached.
  if (!pcm || pcm.byteLength < 2 || pcm.byteLength % 2 !== 0) {
    return { ok: false, reason: "invalid_pcm", source: "unavailable" };
  }
  if (pcm.byteLength > MAX_VOICE_NOTE_PCM_BYTES) {
    return { ok: false, reason: "pcm_too_large", source: "unavailable" };
  }

  const isProduction = env["NODE_ENV"] === "production";
  // Automated tests use the local encoder: no test run may reach the real
  // media plane through ambient bindings.
  const gateway = env["NODE_ENV"] === "test" ? null : resolveOpusGatewayConfig(env);

  if (gateway) {
    const encoded = await encodeOggOpusViaGateway(pcm, gateway);
    if (encoded.ok) return { ok: true, bytes: encoded.bytes, source: "native_gateway" };
    console.error(`[voice] opus_gateway_encode_failed reason=${encoded.reason}`);
    // Fail closed in production: the known-failing in-Worker WASM path must not
    // be attempted on the normal voice-note flow.
    if (isProduction) return { ok: false, reason: encoded.reason, source: "native_gateway" };
  } else if (isProduction) {
    // No media plane configured in production: fail closed immediately without
    // importing or attempting the local WASM encoder.
    console.error("[voice] opus_gateway_not_configured");
    return { ok: false, reason: "gateway_not_configured", source: "native_gateway" };
  }

  const { encodePcmToOggOpus } = await import("./opus-encode.server");
  const local = await encodePcmToOggOpus(pcm);
  if (local.ok) return { ok: true, bytes: local.bytes, source: "local_wasm" };
  return { ok: false, reason: local.reason, source: "local_wasm" };
}
