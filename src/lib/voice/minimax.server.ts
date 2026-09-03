/**
 * UMRAIO® VOICE — MiniMax Speech 2.8 HD driver (PROOF OF CONCEPT).
 *
 * SCOPE: TTS ONLY. MiniMax is a voice engine here — it never touches ASR, the
 * RÉNAIO.CORE™ orchestration layer, or any business logic.
 *
 * ACTIVATION: strictly opt-in. The driver is only reachable when it is asked
 * for explicitly (VOICE_TTS_ENGINE=minimax or an explicit engine argument) AND
 * MINIMAX_TTS_API_KEY (or the legacy MINIMAX_API_KEY) is configured. Production
 * users keep the proven OpenAI Direct pipeline untouched until this POC is validated.
 *
 * SECURITY: MINIMAX_TTS_API_KEY (preferred), MINIMAX_API_KEY (legacy) and
 * MINIMAX_GROUP_ID are read at call time inside the handler, stay server-side,
 * are never logged, never returned and never embedded in an error message.
 */

import type { TtsFailureKind, TtsResult, VoiceEngine } from "./tts.server";
import { isSupportedTtsVoice } from "./persona.core";
import { resolveVoiceLanguage } from "./language.core";

export const MINIMAX_DEFAULT_MODEL = "speech-2.8-hd";
/**
 * Required UMRAIO MiniMax voice. Passed verbatim to the MiniMax TTS API as
 * voice_id. MINIMAX_TTS_VOICE_ID env override still takes precedence.
 */
export const MINIMAX_DEFAULT_VOICE_ID = "Malay_male_1_v1";
export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io/v1";
/** Bounded latency: a hung provider must never stall a WhatsApp turn. */
export const MINIMAX_TTS_TIMEOUT_MS = 15_000;
/** 1 initial attempt + at most ONE retry, transient failures only. */
export const MINIMAX_TTS_MAX_ATTEMPTS = 2;

/**
 * WHATSAPP SPEED PARITY — MiniMax always speaks at its natural rate.
 *
 * The Voice Console `pace` control was designed against OpenAI TTS `speed`
 * (0.86–1.06). Inheriting it on MiniMax made the real WhatsApp note drift from
 * the validated MiniMax Voice Test, which sends no speed at all. MiniMax is
 * therefore pinned to 1.0. OpenAI Direct is untouched and still honours pace.
 */
export const MINIMAX_FIXED_SPEED = 1;

/** MP3 is a container Meta accepts for a voice note (as an attachment bubble). */
const MINIMAX_AUDIO_FORMAT: "mp3" = "mp3";
const MINIMAX_AUDIO_MIME = "audio/mpeg";
/** OGG/Opus is the ONLY container Meta renders as a NATIVE voice note. */
const MINIMAX_OGG_MIME = "audio/ogg";
/** Validated MiniMax PCM shape: s16le, 24 kHz, mono — no resampling needed. */
export const MINIMAX_PCM_SAMPLE_RATE = 24000;
export const MINIMAX_PCM_CHANNELS = 1;

export type MinimaxContainer = "mp3" | "ogg_opus";

/**
 * FEATURE FLAG — MINIMAX_TTS_CONTAINER. Default "mp3": production keeps the
 * proven MP3 path until the OGG/Opus voice note is validated in the field.
 */
export function resolveMinimaxContainer(): MinimaxContainer {
  return env("MINIMAX_TTS_CONTAINER")?.toLowerCase() === "ogg_opus" ? "ogg_opus" : "mp3";
}




function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export type MinimaxConfig = {
  baseUrl: string;
  apiKey: string;
  groupId: string | null;
  model: string;
  voiceId: string;
};

/** Null when the POC is not configured — the caller then fails over cleanly. */
export function resolveMinimaxConfig(): MinimaxConfig | null {
  const apiKey = env("MINIMAX_TTS_API_KEY") ?? env("MINIMAX_API_KEY");
  if (!apiKey) return null;
  return {
    baseUrl: (env("MINIMAX_BASE_URL") ?? MINIMAX_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    groupId: env("MINIMAX_GROUP_ID") ?? null,
    model: env("MINIMAX_TTS_MODEL") ?? MINIMAX_DEFAULT_MODEL,
    voiceId: env("MINIMAX_TTS_VOICE_ID") ?? MINIMAX_DEFAULT_VOICE_ID,
  };
}

/** Non-secret diagnostic — presence flags only, never values. */
export function describeMinimax(): {
  configured: boolean;
  model: string;
  voiceId: string;
  groupIdConfigured: boolean;
} {
  const config = resolveMinimaxConfig();
  return {
    configured: Boolean(config),
    model: config?.model ?? MINIMAX_DEFAULT_MODEL,
    voiceId: config?.voiceId ?? MINIMAX_DEFAULT_VOICE_ID,
    groupIdConfigured: Boolean(config?.groupId),
  };
}

function classifyHttp(status: number): { kind: TtsFailureKind; retryable: boolean } {
  if (status === 402) return { kind: "entitlement", retryable: false };
  if (status === 401 || status === 403) return { kind: "unauthorized", retryable: false };
  if (status === 429) return { kind: "rate_limited", retryable: true };
  if (status === 400 || status === 404) return { kind: "invalid_request", retryable: false };
  return { kind: "provider", retryable: true };
}

/**
 * MULTILINGUAL TTS — maps the EXISTING conversation voice language
 * (`agency_settings.voice_language`, resolved by language.core) to the MiniMax
 * `language_boost` label. No second detection pipeline: the caller passes the
 * already-resolved language. Missing/unknown/"auto" → "Malay" (never guessed
 * from the voice ID; voice identity and language are separate concerns).
 */
export function languageBoostFor(language: string | null | undefined): string {
  switch (resolveVoiceLanguage(language)) {
    case "en-US":
      return "English";
    case "id-ID":
      return "Indonesian";
    case "ar-SA":
      return "Arabic";
    case "zh-CN":
      return "Chinese";
    case "ta-IN":
      return "Tamil";
    case "ur-PK":
      return "Urdu";
    case "bn-BD":
      return "Bengali";
    default:
      // ms-MY, "auto" and anything unresolvable.
      return "Malay";
  }
}

/** MiniMax returns audio as a lowercase hex string. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length < 2 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

type MinimaxResponse = {
  data?: { audio?: string; status?: number };
  base_resp?: { status_code?: number; status_msg?: string };
};

type MinimaxAudio =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: TtsFailureKind };

/**
 * ONE MiniMax T2A v2 request (with the existing bounded retry policy).
 * The container is the ONLY thing that varies between calls — voice, model,
 * language_boost, speed, vol and pitch are identical for MP3 and PCM.
 */
async function requestMinimaxAudio(
  config: MinimaxConfig,
  body: string,
): Promise<MinimaxAudio> {
  const url = config.groupId
    ? `${config.baseUrl}/t2a_v2?GroupId=${encodeURIComponent(config.groupId)}`
    : `${config.baseUrl}/t2a_v2`;

  for (let attempt = 1; attempt <= MINIMAX_TTS_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MINIMAX_TTS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const isTimeout = error instanceof Error && error.name === "AbortError";
      console.error(
        `[voice] tts_failed engine=minimax category=${isTimeout ? "timeout" : "network"} attempt=${attempt}`,
      );
      if (attempt < MINIMAX_TTS_MAX_ATTEMPTS) continue;
      return { ok: false, kind: isTimeout ? "timeout" : "provider" };
    }

    if (!res.ok) {
      clearTimeout(timer);
      const failure = classifyHttp(res.status);
      console.error(
        `[voice] tts_failed engine=minimax category=${failure.kind} status=${res.status} attempt=${attempt}`,
      );
      if (failure.retryable && attempt < MINIMAX_TTS_MAX_ATTEMPTS) continue;
      return { ok: false, kind: failure.kind };
    }

    let payload: MinimaxResponse;
    try {
      payload = (await res.json()) as MinimaxResponse;
    } catch {
      clearTimeout(timer);
      console.error("[voice] tts_failed engine=minimax category=invalid_audio reason=bad_json");
      return { ok: false, kind: "invalid_audio" };
    }
    clearTimeout(timer);

    const statusCode = payload.base_resp?.status_code ?? 0;
    if (statusCode !== 0) {
      // status_msg may echo request details — only the numeric code is logged.
      const retryable = statusCode === 1002 || statusCode === 1039 || statusCode === 2013;
      console.error(
        `[voice] tts_failed engine=minimax category=provider code=${statusCode} attempt=${attempt}`,
      );
      if (retryable && attempt < MINIMAX_TTS_MAX_ATTEMPTS) continue;
      // 1008 = insufficient balance: a billing/entitlement state, NOT a bad
      // credential. Keeping it distinct stops a topped-up-but-wrong-account
      // situation from being misread as a broken key.
      const kind: TtsFailureKind =
        statusCode === 1008
          ? "entitlement"
          : statusCode === 1004 || statusCode === 2049
            ? "unauthorized"
            : statusCode === 1002
              ? "rate_limited"
              : "provider";
      return { ok: false, kind };
    }

    const bytes = hexToBytes(payload.data?.audio ?? "");
    if (bytes.byteLength === 0) {
      console.error("[voice] tts_failed engine=minimax category=invalid_audio reason=empty");
      return { ok: false, kind: "invalid_audio" };
    }
    return { ok: true, bytes };
  }

  return { ok: false, kind: "provider" };
}

/**
 * MiniMax T2A v2 driver.
 *
 * Non-streaming HTTP is used because WhatsApp requires a COMPLETE audio file.
 *
 * CONTAINER (MINIMAX_TTS_CONTAINER, default "mp3"):
 *   - "mp3"      : the proven production path — audio/mpeg attachment.
 *   - "ogg_opus" : request raw PCM (s16le/24k/mono) and encode it to OGG/Opus
 *                  in-process so Meta renders a NATIVE voice note. ANY PCM or
 *                  encoder failure falls back to exactly ONE MP3 request, so a
 *                  voice reply is never lost.
 */
export const minimaxVoiceEngine: VoiceEngine = {
  name: "minimax",
  async synthesize({ text, voice, language, requireOggOpus }): Promise<TtsResult> {
    const config = resolveMinimaxConfig();
    if (!config) {
      console.error("[voice] tts_failed engine=minimax category=config");
      return { ok: false, kind: "config", engine: "minimax" };
    }

    /**
     * Voice resolution order:
     * 1. MINIMAX_TTS_VOICE_ID env override (custom / voice-designed MiniMax voice).
     * 2. An explicit caller voice — but ONLY if it is a real MiniMax voice ID.
     *    Persona voices (alloy, coral, ...) are OpenAI system voices and must
     *    never be sent to MiniMax; sending them silently falls back to a
     *    robotic provider default.
     * 3. MINIMAX_DEFAULT_VOICE_ID ("Malay_male_1_v1").
     */
    const callerVoice = voice && !isSupportedTtsVoice(voice) ? voice : undefined;

    const requestBody = (format: "mp3" | "pcm") =>
      JSON.stringify({
        model: config.model,
        text,
        stream: false,
        language_boost: languageBoostFor(language),
        output_format: "hex",
        voice_setting: {
          voice_id: callerVoice ?? config.voiceId,
          // Persona pace is deliberately NOT inherited here — see MINIMAX_FIXED_SPEED.
          speed: MINIMAX_FIXED_SPEED,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: MINIMAX_PCM_SAMPLE_RATE,
          bitrate: 128000,
          format,
          channel: MINIMAX_PCM_CHANNELS,
        },
      });

    // WhatsApp Calling can transmit nothing but OGG/Opus, so it always takes
    // the PCM→Opus path regardless of the WhatsApp-message container flag.
    if (requireOggOpus || resolveMinimaxContainer() === "ogg_opus") {
      const pcm = await requestMinimaxAudio(config, requestBody("pcm"));
      if (pcm.ok) {
        const { encodePcmToOggOpus } = await import("./opus-encode.server");
        const encoded = await encodePcmToOggOpus(pcm.bytes);
        if (encoded.ok) {
          return {
            ok: true,
            bytes: encoded.bytes,
            mimeType: MINIMAX_OGG_MIME,
            engine: "minimax",
          };
        }
        // The PCM call already succeeded — the ONLY retry is the MP3 container.
        console.error(`[voice] minimax_opus_encode_failed reason=${encoded.reason} fallback=mp3`);
      } else {
        console.error(`[voice] minimax_pcm_failed kind=${pcm.kind} fallback=mp3`);
      }
    }

    const mp3 = await requestMinimaxAudio(config, requestBody(MINIMAX_AUDIO_FORMAT));
    if (!mp3.ok) return { ok: false, kind: mp3.kind, engine: "minimax" };
    return { ok: true, bytes: mp3.bytes, mimeType: MINIMAX_AUDIO_MIME, engine: "minimax" };
  },
};

