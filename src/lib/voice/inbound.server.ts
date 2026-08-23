/**
 * UMRAIO® VOICE V1 — inbound audio → transcript.
 *
 * This is NOT a second brain. It produces the text the customer spoke and hands
 * it to the EXISTING WhatsApp text pipeline (lead → conversation → coalescing →
 * RÉNAIO.CORE™ → AI SALES ELITE™ → sendWhatsappText). Nothing downstream knows
 * or cares that the message arrived as audio.
 *
 * Ordering guarantee (callers must preserve it):
 *   C2 idempotency  →  voice quota  →  media download  →  limits  →  ASR  →  meter
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { QuotaError, assertVoiceQuota, recordUsageEvent } from "@/lib/billing/usage.server";

import { transcribeAudio, ASR_MODEL } from "./asr.server";
import {
  checkAudioLimits,
  estimateDurationSeconds,
  fallbackMessageFor,
  normalizeTranscript,
  type VoiceRejection,
} from "./limits.core";
import { fetchWhatsappAudio } from "./media.server";

export type VoiceIngestResult =
  | { ok: true; transcript: string; durationSeconds: number }
  | { ok: false; reason: VoiceRejection; customerMessage: string };

function reject(reason: VoiceRejection): VoiceIngestResult {
  return { ok: false, reason, customerMessage: fallbackMessageFor(reason) };
}

export async function ingestVoiceNote(
  supabase: any,
  args: {
    agencyId: string;
    mediaId: string;
    accessToken: string;
    /** Meta message id — makes usage metering idempotent across replays. */
    providerMessageId: string | null;
    /** Agency voice_language; omitted/null keeps model auto-detection. */
    voiceLanguage?: string | null;
  },
): Promise<VoiceIngestResult> {
  const startedAt = Date.now();
  console.log(`[voice] audio_received agency_id=${args.agencyId} media_id=${args.mediaId}`);

  // 1. QUOTA — before any paid work. A rejected quota never reaches ASR.
  try {
    await assertVoiceQuota(supabase, args.agencyId, 0);
    console.log(`[voice] quota_decision=allowed agency_id=${args.agencyId}`);
  } catch (error) {
    if (error instanceof QuotaError) {
      console.log(`[voice] quota_decision=denied kind=${error.kind} agency_id=${args.agencyId}`);
      return reject("quota_exceeded");
    }
    console.error("[voice] quota_decision=error");
    return reject("quota_exceeded");
  }

  // 2. MEDIA — server-side only; token and temporary URL never leave here.
  const media = await fetchWhatsappAudio(args.mediaId, args.accessToken);
  if (!media.ok) {
    console.error(`[voice] media_retrieval=failed reason=${media.reason}`);
    return reject(media.reason === "too_large" ? "too_large" : media.reason);
  }
  console.log(`[voice] media_retrieval=ok bytes=${media.byteLength} mime=${media.mimeType}`);

  // 3. LIMITS — size / duration, before ASR.
  const limits = checkAudioLimits({ bytes: media.byteLength });
  if (!limits.ok) {
    console.log(`[voice] audio_rejected reason=${limits.reason} bytes=${media.byteLength}`);
    return reject(limits.reason);
  }
  console.log(`[voice] audio_duration_estimate_s=${limits.durationSeconds}`);

  // 4. ASR.
  console.log("[voice] asr_started model=" + ASR_MODEL);
  const asr = await transcribeAudio({
    bytes: media.bytes,
    mimeType: media.mimeType,
    ...(args.voiceLanguage === undefined ? {} : { language: args.voiceLanguage }),
  });
  if (!asr.ok) {
    // A failed transcription is NEVER charged as a successful one.
    await recordUsageEvent(supabase, {
      agencyId: args.agencyId,
      eventKey: `voice:${args.agencyId}:${args.providerMessageId ?? args.mediaId}`,
      category: "voice_transcription",
      source: "whatsapp",
      worker: "whatsapp_executive",
      model: ASR_MODEL,
      provider: "lovable_ai",
      success: false,
      durationSeconds: 0,
      latencyMs: Date.now() - startedAt,
      meta: { failure: asr.kind },
    });
    console.error(`[voice] asr_failure category=${asr.kind}`);
    return reject("asr_failed");
  }

  const durationSeconds = asr.durationSeconds ?? limits.durationSeconds;
  const transcript = normalizeTranscript(asr.text);
  console.log(
    `[voice] asr_success chars=${transcript.length} duration_s=${durationSeconds} latency_ms=${Date.now() - startedAt}`,
  );

  // 5. METER — actual duration, idempotent by Meta message id (replay-safe).
  await recordUsageEvent(supabase, {
    agencyId: args.agencyId,
    eventKey: `voice:${args.agencyId}:${args.providerMessageId ?? args.mediaId}`,
    category: "voice_transcription",
    source: "whatsapp",
    worker: "whatsapp_executive",
    model: ASR_MODEL,
    provider: "lovable_ai",
    success: true,
    durationSeconds,
    latencyMs: Date.now() - startedAt,
  });

  console.log(
    `[voice] transcript_pipeline_entry total_latency_ms=${Date.now() - startedAt} duration_s=${durationSeconds}`,
  );
  return { ok: true, transcript, durationSeconds };
}

export { estimateDurationSeconds };
