/**
 * UMRAIO® VOICE V1 — deterministic limits and customer-facing fallback.
 *
 * Voice is only a new INPUT modality. Nothing here knows about sales, the
 * persona or the pipeline — it only decides whether an audio note is safe to
 * transcribe, and what the customer is told when it is not.
 */

/** Maximum accepted voice-note duration (seconds). */
export const MAX_VOICE_SECONDS = 30;

/** Maximum accepted downloaded media size (bytes). */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

/**
 * WhatsApp voice notes are Opus mono at roughly 16 kbps. Meta's media metadata
 * carries no duration, so duration is ESTIMATED from the payload size for the
 * pre-flight limit/quota check and corrected afterwards when the ASR provider
 * reports a real duration.
 */
export const VOICE_BYTES_PER_SECOND = 2_000;

export function estimateDurationSeconds(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.max(1, Math.round(bytes / VOICE_BYTES_PER_SECOND));
}

export type VoiceRejection =
  | "too_large"
  | "too_long"
  | "empty_audio"
  | "unsupported_media"
  | "media_unavailable"
  | "quota_exceeded"
  | "inaudible"
  | "asr_failed";

/**
 * One concise, non-technical fallback. It never leaks provider names, status
 * codes, credentials or internal diagnostics.
 */
export const VOICE_FALLBACK_MESSAGE =
  "Maaf, saya tak dapat memproses voice note itu sekarang. Boleh cuba hantar semula atau taip mesej anda?";

export const VOICE_TOO_LONG_MESSAGE =
  "Maaf, voice note itu agak panjang. Boleh hantar voice note lebih pendek (bawah 30 saat) atau taip mesej anda?";

/**
 * Quota is a TRUTHFUL, distinct reason — never the generic processing failure.
 */
export const VOICE_QUOTA_MESSAGE =
  "Maaf Datuk, penggunaan voice bulan ini dah mencapai had. Datuk boleh taip mesej di sini, atau sambung semula voice selepas had diperbaharui.";

/**
 * The provider transcribed successfully but heard nothing intelligible. Voice
 * notes ARE supported — the customer is simply asked to resend.
 */
export const VOICE_INAUDIBLE_MESSAGE =
  "Maaf Datuk, suara tadi tak dapat saya dengar dengan jelas. Boleh hantar sekali lagi?";

export function fallbackMessageFor(reason: VoiceRejection): string {
  if (reason === "too_long" || reason === "too_large") return VOICE_TOO_LONG_MESSAGE;
  if (reason === "quota_exceeded") return VOICE_QUOTA_MESSAGE;
  if (reason === "inaudible" || reason === "empty_audio") return VOICE_INAUDIBLE_MESSAGE;
  return VOICE_FALLBACK_MESSAGE;
}

/** Pre-flight size/duration gate, run BEFORE any ASR call. */
export function checkAudioLimits(args: {
  bytes: number;
  durationSeconds?: number | null;
}): { ok: true; durationSeconds: number } | { ok: false; reason: VoiceRejection } {
  if (!Number.isFinite(args.bytes) || args.bytes <= 0) return { ok: false, reason: "empty_audio" };
  if (args.bytes > MAX_VOICE_BYTES) return { ok: false, reason: "too_large" };
  const duration =
    typeof args.durationSeconds === "number" && args.durationSeconds > 0
      ? Math.round(args.durationSeconds)
      : estimateDurationSeconds(args.bytes);
  if (duration > MAX_VOICE_SECONDS) return { ok: false, reason: "too_long" };
  return { ok: true, durationSeconds: duration };
}

/**
 * Transcript normalization — whitespace only. Names, numbers, dates, currency,
 * package references and Malay-English code switching are preserved verbatim:
 * the transcript IS the customer's message, never a rewrite or a summary.
 */
export function normalizeTranscript(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  // Zero-width / BOM characters some providers emit would otherwise survive the
  // whitespace collapse and make a blank transcript look like content.
  return raw.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}


/**
 * A transcript that carries no speech content: empty, whitespace, or only
 * punctuation / filler markers some models emit for silence. Malay words,
 * digits, currency and code-switched English are ALWAYS content.
 */
export function isEffectivelyEmptyTranscript(text: string | null | undefined): boolean {
  const value = normalizeTranscript(text ?? "");
  if (!value) return true;
  // Strip punctuation and bracketed markers such as "[silence]" / "(inaudible)".
  const stripped = value
    .replace(/[[(][^\])]*[\])]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
  return stripped.length === 0;
}
