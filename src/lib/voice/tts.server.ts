/**
 * UMRAIO® VOICE V3 — server-only speech synthesis with a real provider layer.
 *
 * ENGINE-AGNOSTIC BY DESIGN. `VoiceEngine` is the only contract the pipeline
 * knows about. Two drivers ship today:
 *   - `lovable`  : Lovable AI voice (OpenAI gpt-4o-mini-tts) — proven, emits a
 *                  complete OGG/Opus file, exactly what Meta accepts.
 *   - `xiaozhi`  : a SELF-HOSTED XiaoZhi TTS HTTP endpoint. XiaoZhi publishes
 *                  no hosted cloud TTS API, so this driver stays inert unless
 *                  XIAOZHI_TTS_URL is configured. When it is not configured it
 *                  fails cleanly and the chain falls back to `lovable`.
 *
 * FALLBACK CONTRACT: `synthesizeSpeech` tries the selected provider first and
 * falls back to the proven provider on any failure. A total TTS failure never
 * touches the text answer, the Islamic review workflow or the WhatsApp turn.
 *
 * SECURITY: credentials stay in this module, are never logged and never
 * returned. Audio bytes are held in memory only and never persisted.
 */

import { openAiAudioProvider, lovableAudioProvider, resolveAudioProviders, type AudioProvider } from "@/lib/ai/audio.server";

export type VoiceEngineName = "openai" | "lovable" | "xiaozhi";

export type TtsFailureKind =
  | "config"
  | "unsupported_engine"
  | "rate_limited"
  | "entitlement"
  | "invalid_request"
  | "provider";

export type TtsResult =
  | { ok: true; bytes: Uint8Array; mimeType: string; engine: VoiceEngineName }
  | { ok: false; kind: TtsFailureKind; engine: VoiceEngineName };

export type VoiceSynthesisRequest = {
  text: string;
  voice?: string;
  /** Engine-level speaking rate (OpenAI TTS `speed`, 0.25–4.0). */
  speed?: number;
  /** Natural-language steering for engines that accept it. */
  instructions?: string;
};

export type VoiceEngine = {
  name: VoiceEngineName;
  synthesize(input: VoiceSynthesisRequest): Promise<TtsResult>;
};

/** WhatsApp voice notes must be Opus in an OGG container. */
export const OUTBOUND_AUDIO_MIME = "audio/ogg";

/** Container/codec Meta accepts for a voice note. Anything else is rejected. */
const WHATSAPP_AUDIO_MIMES = new Set([
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
]);

export function isWhatsappCompatibleAudio(mimeType: string): boolean {
  return WHATSAPP_AUDIO_MIMES.has((mimeType || "").split(";")[0]!.trim().toLowerCase());
}

export const LOVABLE_TTS_MODEL = "openai/gpt-4o-mini-tts";
export const DEFAULT_VOICE = "sage";

export const DEFAULT_VOICE_INSTRUCTIONS =
  "You are a warm, confident Malaysian Umrah travel executive speaking Bahasa Melayu on a WhatsApp voice note. Speak conversationally, not like a news reader: unhurried pace, gentle warmth, natural rises and falls, a short breath at commas and a real pause at full stops. Pronounce Malay words with Malaysian pronunciation and Arabic terms respectfully. Never spell out punctuation, symbols, links or reference codes.";

function classify(status: number): TtsFailureKind {
  if (status === 400 || status === 404) return "invalid_request";
  if (status === 401) return "config";
  if (status === 402 || status === 403) return "entitlement";
  if (status === 429) return "rate_limited";
  return "provider";
}

/**
 * One driver for every OpenAI-compatible speech endpoint. The provider (OpenAI
 * Direct in production, the optional Lovable gateway as fallback) supplies the
 * base URL, credentials and model id — this driver holds no vendor knowledge.
 */
function hostedSpeechEngine(
  name: VoiceEngineName,
  resolve: () => AudioProvider | null,
): VoiceEngine {
  return {
    name,
    async synthesize({ text, voice, speed, instructions }) {
      const provider = resolve();
      if (!provider) {
        console.error(`[voice] tts_failed engine=${name} category=config`);
        return { ok: false, kind: "config", engine: name };
      }
      let res: Response;
      try {
        res = await fetch(`${provider.baseUrl}/audio/speech`, {
          method: "POST",
          headers: { ...provider.headers(), "Content-Type": "application/json" },
          body: JSON.stringify({
            model: provider.speechModel,
            input: text,
            voice: voice ?? DEFAULT_VOICE,
            ...(typeof speed === "number"
              ? { speed: Math.min(4, Math.max(0.25, speed)) }
              : {}),
            // Complete OGG/Opus file — exactly what Meta accepts as a voice note.
            response_format: "opus",
            instructions: instructions ?? DEFAULT_VOICE_INSTRUCTIONS,
          }),
        });
      } catch (error) {
        console.error(
          `[voice] tts_failed engine=${name} category=network name=${error instanceof Error ? error.name : "unknown"}`,
        );
        return { ok: false, kind: "provider", engine: name };
      }

      if (!res.ok) {
        const kind = classify(res.status);
        console.error(`[voice] tts_failed engine=${name} category=${kind} status=${res.status}`);
        return { ok: false, kind, engine: name };
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) {
        console.error(`[voice] tts_failed engine=${name} category=empty_audio`);
        return { ok: false, kind: "provider", engine: name };
      }
      return { ok: true, bytes, mimeType: OUTBOUND_AUDIO_MIME, engine: name };
    },
  };
}

/** Production provider: OpenAI Direct (server-side OPENAI_API_KEY only). */
export const openAiVoiceEngine: VoiceEngine = hostedSpeechEngine("openai", openAiAudioProvider);

/** OPTIONAL fallback: the Lovable AI Gateway, used only when configured. */
export const lovableVoiceEngine: VoiceEngine = hostedSpeechEngine("lovable", lovableAudioProvider);

/**
 * SELF-HOSTED XiaoZhi TTS driver.
 *
 * XiaoZhi (xiaozhi-esp32-server) is an ESP32 voice-assistant backend that
 * itself wraps third-party TTS engines; there is no public XiaoZhi cloud TTS
 * API to call. This driver therefore targets a deployment the operator runs,
 * declared through XIAOZHI_TTS_URL (+ optional XIAOZHI_TTS_API_KEY /
 * XIAOZHI_TTS_VOICE). Unconfigured — the default — it fails cleanly with
 * `unsupported_engine` and the chain falls back to the proven provider.
 *
 * The endpoint MUST return a complete WhatsApp-compatible audio file
 * (OGG/Opus preferred). Device-framed Opus (XiaoZhi's `p3` stream) is NOT a
 * playable file and is rejected rather than uploaded to Meta.
 */
export const xiaozhiVoiceEngine: VoiceEngine = {
  name: "xiaozhi",
  async synthesize({ text, voice, speed, instructions }) {
    const endpoint = (process.env["XIAOZHI_TTS_URL"] ?? "").trim();
    if (!endpoint) {
      console.error("[voice] tts_failed engine=xiaozhi category=unsupported_engine");
      return { ok: false, kind: "unsupported_engine", engine: "xiaozhi" };
    }
    const apiKey = (process.env["XIAOZHI_TTS_API_KEY"] ?? "").trim();
    // Which TTS backend the self-hosted XiaoZhi gateway should select
    // (edge / doubao / minimax / cosyvoice / fishaudio ...). XiaoZhi is the
    // orchestration layer; naturalness comes from this provider.
    const provider = (process.env["XIAOZHI_TTS_PROVIDER"] ?? "").trim();
    const format = (process.env["XIAOZHI_TTS_FORMAT"] ?? "ogg_opus").trim();
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          text,
          voice: voice ?? process.env["XIAOZHI_TTS_VOICE"] ?? undefined,
          ...(provider ? { provider } : {}),
          ...(typeof speed === "number" ? { speed } : {}),
          ...(instructions ? { instructions } : {}),
          format,
          language: "ms-MY",
        }),
      });

    } catch (error) {
      console.error(
        `[voice] tts_failed engine=xiaozhi category=network name=${error instanceof Error ? error.name : "unknown"}`,
      );
      return { ok: false, kind: "provider", engine: "xiaozhi" };
    }
    if (!res.ok) {
      const kind = classify(res.status);
      console.error(`[voice] tts_failed engine=xiaozhi category=${kind} status=${res.status}`);
      return { ok: false, kind, engine: "xiaozhi" };
    }
    const mimeType = (res.headers.get("content-type") ?? OUTBOUND_AUDIO_MIME)
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      console.error("[voice] tts_failed engine=xiaozhi category=empty_audio");
      return { ok: false, kind: "provider", engine: "xiaozhi" };
    }
    if (!isWhatsappCompatibleAudio(mimeType)) {
      console.error(`[voice] tts_failed engine=xiaozhi category=incompatible_audio_format`);
      return { ok: false, kind: "invalid_request", engine: "xiaozhi" };
    }
    return { ok: true, bytes, mimeType, engine: "xiaozhi" };
  },
};

export const VOICE_ENGINES: Record<VoiceEngineName, VoiceEngine> = {
  openai: openAiVoiceEngine,
  lovable: lovableVoiceEngine,
  xiaozhi: xiaozhiVoiceEngine,
};

/** Legacy constant; the live fallback is resolved by `provenEngine()`. */
export const FALLBACK_ENGINE_NAME: VoiceEngineName = "lovable";

/**
 * The proven provider every chain falls back to: OpenAI Direct in production,
 * the Lovable gateway only when OpenAI is not configured.
 */
export function provenEngine(): VoiceEngine {
  const chain = resolveAudioProviders();
  const primary = chain[0];
  if (primary?.id === "openai") return openAiVoiceEngine;
  if (primary?.id === "lovable") return lovableVoiceEngine;
  return lovableVoiceEngine;
}

export function selectVoiceEngine(name?: string | null): VoiceEngine {
  const requested = (name ?? process.env["VOICE_TTS_ENGINE"] ?? "").trim().toLowerCase();
  if (requested === "xiaozhi") return xiaozhiVoiceEngine;
  if (requested === "openai") return openAiVoiceEngine;
  if (requested === "lovable") return lovableVoiceEngine;
  return provenEngine();
}

/** Selected provider first, proven provider second (deduplicated). */
export function selectVoiceProviderChain(name?: string | null): VoiceEngine[] {
  const primary = selectVoiceEngine(name);
  const fallback = provenEngine();
  return primary.name === fallback.name ? [primary] : [primary, fallback];
}

export async function synthesizeSpeech(
  input: VoiceSynthesisRequest & { engine?: VoiceEngine; provider?: string | null },
): Promise<TtsResult> {
  const chain = input.engine ? [input.engine] : selectVoiceProviderChain(input.provider);
  console.log(`[voice] VOICE_PROVIDER chain=${chain.map((e) => e.name).join(">")}`);

  let last: TtsResult = { ok: false, kind: "provider", engine: chain[0]!.name };
  for (const engine of chain) {
    const started = Date.now();
    const result = await engine.synthesize({
      text: input.text,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(typeof input.speed === "number" ? { speed: input.speed } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
    });
    const latency = Date.now() - started;
    if (result.ok) {
      console.log(
        `[voice] VOICE_PROVIDER_SELECTED provider=${engine.name} VOICE_PROVIDER_LATENCY=${latency} VOICE_AUDIO_FORMAT=${result.mimeType} VOICE_AUDIO_BYTES=${result.bytes.byteLength}`,
      );
      console.log(
        `[voice] tts_success engine=${engine.name} bytes=${result.bytes.byteLength} latency_ms=${latency}`,
      );
      return result;
    }
    last = result;
    console.error(
      `[voice] VOICE_PROVIDER_FAILOVER provider=${engine.name} category=${result.kind} VOICE_PROVIDER_LATENCY=${latency}`,
    );
  }
  return last;
}
