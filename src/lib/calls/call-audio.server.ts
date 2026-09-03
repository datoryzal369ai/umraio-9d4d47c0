/**
 * UMRAIO® — WhatsApp Calling speech synthesis. LOCKED VOICE, NO SUBSTITUTES.
 *
 * SPECIFICATION (non-negotiable):
 *   provider       = minimax
 *   model          = speech-2.8-hd
 *   voice_id       = Malay_male_1_v1   (MINIMAX_TTS_VOICE_ID may override)
 *   language_boost = Malay
 *   locale         = ms-MY
 *   container      = OGG/Opus (the only container the RTP path can transmit)
 *
 * There is NO fallback engine. A previous OpenAI fallback silently replaced the
 * Malaysian voice with an OpenAI voice on every live turn (evidence: call
 * ms_317c3396926af52a1f46a5aa, `voice_turn_tts_primary_rejected ...
 * fallback=openai`). Substituting a voice is now a hard, reported failure:
 * the caller hears nothing rather than the wrong identity.
 *
 * Logs carry provider/voice/container/reason only — never audio or PII.
 */
import { isOggOpusAudio } from "./call-audio.core";
import { MINIMAX_DEFAULT_MODEL, resolveMinimaxConfig } from "@/lib/voice/minimax.server";
import { lazyMinimaxEngine, synthesizeSpeech, type VoiceSynthesisRequest } from "@/lib/voice/tts.server";

export type CallSpeechResult =
  | { ok: true; bytes: Uint8Array; engine: string; voiceId: string; fallbackUsed: false }
  | { ok: false; reason: string };

/** The voice identity a call turn MUST be spoken with. */
export function requiredCallVoice(): { model: string; voiceId: string } {
  const config = resolveMinimaxConfig();
  return {
    model: config?.model ?? MINIMAX_DEFAULT_MODEL,
    voiceId: config?.voiceId ?? "Malay_male_1_v1",
  };
}

export async function synthesizeCallSpeech(
  input: VoiceSynthesisRequest & { callId?: string },
  deps: { synthesize?: typeof synthesizeSpeech } = {},
): Promise<CallSpeechResult> {
  const synth = deps.synthesize ?? synthesizeSpeech;
  const callId = input.callId ?? "unknown";
  const { model, voiceId } = requiredCallVoice();

  const request: VoiceSynthesisRequest & { engine: typeof lazyMinimaxEngine } = {
    text: input.text,
    // The realtime call path can only transmit OGG/Opus — no MP3 round trip.
    requireOggOpus: true,
    // Voice identity is LOCKED: a persona voice must never reach MiniMax.
    engine: lazyMinimaxEngine,
    ...(typeof input.speed === "number" ? { speed: input.speed } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.language ? { language: input.language } : {}),
  };

  const result = await synth(request);
  if (result.ok && isOggOpusAudio(result.mimeType, result.bytes)) {
    if (result.engine !== "minimax") {
      console.log(
        `[calls] voice_turn_tts_failed call_id=${callId} reason=voice_substitution_blocked provider=${result.engine}`,
      );
      return { ok: false, reason: "voice_substitution_blocked" };
    }
    console.log(
      `[calls] voice_turn_tts_ok call_id=${callId} provider=minimax model=${model} voice=${voiceId} container=ogg_opus fallback=none`,
    );
    return { ok: true, bytes: result.bytes, engine: result.engine, voiceId, fallbackUsed: false };
  }

  const reason = result.ok
    ? `container_${(result.mimeType || "unknown").split(";")[0]!.replace("/", "_")}`
    : `tts_${result.kind}`;
  console.log(
    `[calls] voice_turn_tts_failed call_id=${callId} provider=minimax model=${model} voice=${voiceId} reason=${reason} fallback=none`,
  );
  return { ok: false, reason };
}
