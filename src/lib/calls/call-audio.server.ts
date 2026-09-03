/**
 * UMRAIO® — WhatsApp Calling speech synthesis with a narrow OGG/Opus guarantee.
 *
 * PRIMARY: the configured provider chain (MiniMax with
 * MINIMAX_TTS_CONTAINER=ogg_opus in production).
 * FALLBACK: exactly ONE retry through the OpenAI TTS engine when the primary
 * returns an unsupported container, invalid OGG/Opus, or fails outright.
 *
 * Never returns silent success: the result is either verified OGG/Opus bytes
 * or an explicit failure reason. Logs carry provider/container/fallback status
 * only — never audio, credentials or customer PII.
 */
import { isOggOpusAudio } from "./call-audio.core";
import {
  openAiVoiceEngine,
  synthesizeSpeech,
  type VoiceSynthesisRequest,
  type VoiceEngine,
} from "@/lib/voice/tts.server";

export type CallSpeechResult =
  | { ok: true; bytes: Uint8Array; engine: string; fallbackUsed: boolean }
  | { ok: false; reason: string };

export async function synthesizeCallSpeech(
  input: VoiceSynthesisRequest & { callId?: string },
  deps: {
    synthesize?: typeof synthesizeSpeech;
    fallbackEngine?: VoiceEngine;
  } = {},
): Promise<CallSpeechResult> {
  const synth = deps.synthesize ?? synthesizeSpeech;
  const callId = input.callId ?? "unknown";
  const request: VoiceSynthesisRequest = {
    text: input.text,
    ...(input.voice ? { voice: input.voice } : {}),
    ...(typeof input.speed === "number" ? { speed: input.speed } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.language ? { language: input.language } : {}),
  };

  const primary = await synth(request);
  if (primary.ok && isOggOpusAudio(primary.mimeType, primary.bytes)) {
    console.log(
      `[calls] voice_turn_tts_ok call_id=${callId} provider=${primary.engine} container=ogg_opus fallback=none`,
    );
    return { ok: true, bytes: primary.bytes, engine: primary.engine, fallbackUsed: false };
  }

  const primaryReason = primary.ok
    ? `container_${(primary.mimeType || "unknown").split(";")[0]!.replace("/", "_")}`
    : `tts_${primary.kind}`;
  console.log(
    `[calls] voice_turn_tts_primary_rejected call_id=${callId} provider=${primary.engine} reason=${primaryReason} fallback=openai`,
  );

  // Exactly ONE fallback attempt, through the already-supported OpenAI engine.
  // Resolved lazily so a missing/stubbed OpenAI engine can never break the
  // primary path — it only affects the fallback attempt.
  const fallbackEngine = deps.fallbackEngine ?? openAiVoiceEngine;
  if (!fallbackEngine) {
    console.log(`[calls] voice_turn_tts_failed call_id=${callId} reason=${primaryReason} fallback=unavailable`);
    return { ok: false, reason: primaryReason };
  }
  const fallback = await synth({ ...request, engine: fallbackEngine });
  if (fallback.ok && isOggOpusAudio(fallback.mimeType, fallback.bytes)) {
    console.log(
      `[calls] voice_turn_tts_ok call_id=${callId} provider=${fallback.engine} container=ogg_opus fallback=used`,
    );
    return { ok: true, bytes: fallback.bytes, engine: fallback.engine, fallbackUsed: true };
  }

  const fallbackReason = fallback.ok ? "tts_container_unsupported" : `tts_${fallback.kind}`;
  console.log(
    `[calls] voice_turn_tts_failed call_id=${callId} provider=${fallback.engine} reason=${fallbackReason} fallback=exhausted`,
  );
  return { ok: false, reason: fallbackReason };
}
