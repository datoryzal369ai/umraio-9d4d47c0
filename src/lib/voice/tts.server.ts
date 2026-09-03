/**
 * UMRAIO® VOICE V3 — server-only speech synthesis with a real provider layer.
 *
 * ENGINE-AGNOSTIC BY DESIGN. `VoiceEngine` is the only contract the pipeline
 * knows about. Two drivers ship today:
 *   - `openai`   : OpenAI Direct (gpt-4o-mini-tts) — the PRODUCTION source of
 *                  speech; emits a complete OGG/Opus file, exactly what Meta
 *                  accepts.
 *   - `lovable`  : OPTIONAL non-production compatibility adapter, used only
 *                  when OpenAI Direct is not configured at all. It is never an
 *                  implicit fallback when AI_PROVIDER=openai.
 *   - `xiaozhi`  : a SELF-HOSTED XiaoZhi TTS HTTP endpoint. XiaoZhi publishes
 *                  no hosted cloud TTS API, so this driver stays inert unless
 *                  XIAOZHI_TTS_URL is configured. When it is not configured it
 *                  fails cleanly and the chain falls back to `lovable`.
 *
 * FALLBACK CONTRACT: `synthesizeSpeech` tries the selected provider first and
 * falls back only to OpenAI Direct in strict mode (AI_PROVIDER=openai). A total
 * TTS failure never touches the text answer, the Islamic review workflow or the
 * WhatsApp turn.
 *
 * SECURITY: credentials stay in this module, are never logged and never
 * returned. Audio bytes are held in memory only and never persisted.
 */

import { openAiAudioProvider, lovableAudioProvider, resolveAudioProviders, type AudioProvider } from "@/lib/ai/audio.server";

export type VoiceEngineName = "openai" | "lovable" | "xiaozhi" | "minimax";

export type TtsFailureKind =
  | "config"
  | "unsupported_engine"
  | "timeout"
  | "unauthorized"
  | "rate_limited"
  | "entitlement"
  | "invalid_request"
  | "invalid_audio"
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
  /**
   * Current conversation voice language (e.g. "ms-MY"). Engines that support
   * per-language steering (MiniMax `language_boost`) map this; others ignore
   * it. Missing/unknown → the engine's default (Malay).
   */
  language?: string;
  /**
   * WhatsApp CALLING only: the realtime media path can transmit nothing but
   * OGG/Opus, so an engine must not spend seconds producing a container that
   * will be discarded. Engines that cannot honour it fail fast instead.
   */
  requireOggOpus?: boolean;
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
/**
 * `marin` is the most natural, least announcer-like voice currently supported
 * by gpt-4o-mini-tts (verified against the live supported-voice list).
 */
export const DEFAULT_VOICE = "marin";

export const DEFAULT_VOICE_INSTRUCTIONS =
  "You are a senior Malaysian Umrah travel consultant recording a personal WhatsApp voice note in everyday Malaysian Malay. Speak like a real person in conversation: warm, unhurried, varied intonation, gentle micro-pauses and natural breaths between thoughts, never a repeating or metronome-like rhythm. No announcer, IVR, call-centre or audiobook-narrator delivery, no monotone, no exaggerated emotion, no rushing. Pronounce Malay with Malaysian pronunciation and Arabic or Islamic terms respectfully and exactly as written. Speak prices, dates and package names exactly as given, and never spell out punctuation, symbols, links or reference codes.";

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
/**
 * XIAOZHI TTS HARDENING — bounded latency + bounded retry.
 *
 * A hung self-hosted gateway must never stall the WhatsApp turn: every
 * request (headers AND body) is bounded by an 8s AbortController, and only
 * TRANSIENT failures (timeout, network, 429, 5xx) get exactly one retry.
 * Permanent failures — configuration, 401/403, 400/404, invalid or
 * incompatible audio — return immediately so the provider chain fails over
 * to OpenAI without burning another 8 seconds.
 *
 * SECURITY: the API key and Authorization header are never logged; only
 * failure category and HTTP status are emitted.
 */
export const XIAOZHI_TTS_TIMEOUT_MS = 8_000;
/** 1 initial attempt + at most ONE retry. */
export const XIAOZHI_TTS_MAX_ATTEMPTS = 2;

type XiaozhiFailure = {
  ok: false;
  kind: TtsFailureKind;
  /** Category used in logs — never carries credentials. */
  category: string;
  retryable: boolean;
  status?: number;
};

function classifyXiaozhiHttp(status: number): XiaozhiFailure {
  if (status === 401 || status === 403) {
    return { ok: false, kind: "unauthorized", category: "unauthorized", retryable: false, status };
  }
  if (status === 429) {
    return { ok: false, kind: "rate_limited", category: "rate_limited", retryable: true, status };
  }
  if (status === 400 || status === 404) {
    return { ok: false, kind: "invalid_request", category: "invalid_request", retryable: false, status };
  }
  // 5xx and everything else: transient provider condition — one retry.
  return { ok: false, kind: "provider", category: "provider", retryable: true, status };
}

export const xiaozhiVoiceEngine: VoiceEngine = {
  name: "xiaozhi",
  async synthesize({ text, voice, speed, instructions }) {
    const endpoint = (process.env["XIAOZHI_TTS_URL"] ?? "").trim();
    if (!endpoint) {
      console.error("[voice] tts_failed engine=xiaozhi category=unsupported_engine");
      return { ok: false, kind: "unsupported_engine", engine: "xiaozhi" };
    }
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
    } catch {
      console.error("[voice] tts_failed engine=xiaozhi category=config reason=invalid_url");
      return { ok: false, kind: "config", engine: "xiaozhi" };
    }
    const apiKey = (process.env["XIAOZHI_TTS_API_KEY"] ?? "").trim();
    // Which TTS backend the self-hosted XiaoZhi gateway should select
    // (edge / doubao / minimax / cosyvoice / fishaudio ...). XiaoZhi is the
    // orchestration layer; naturalness comes from this provider.
    const provider = (process.env["XIAOZHI_TTS_PROVIDER"] ?? "").trim();
    const format = (process.env["XIAOZHI_TTS_FORMAT"] ?? "ogg_opus").trim();
    const body = JSON.stringify({
      text,
      voice: voice ?? process.env["XIAOZHI_TTS_VOICE"] ?? undefined,
      ...(provider ? { provider } : {}),
      ...(typeof speed === "number" ? { speed } : {}),
      ...(instructions ? { instructions } : {}),
      format,
      language: "ms-MY",
    });

    for (let attempt = 1; attempt <= XIAOZHI_TTS_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), XIAOZHI_TTS_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const isTimeout = error instanceof Error && error.name === "AbortError";
        const failure: XiaozhiFailure = isTimeout
          ? { ok: false, kind: "timeout", category: "timeout", retryable: true }
          : { ok: false, kind: "provider", category: "network", retryable: true };
        console.error(
          `[voice] tts_failed engine=xiaozhi category=${failure.category} attempt=${attempt}`,
        );
        if (failure.retryable && attempt < XIAOZHI_TTS_MAX_ATTEMPTS) continue;
        return { ok: false, kind: failure.kind, engine: "xiaozhi" };
      }

      if (!res.ok) {
        clearTimeout(timer);
        const failure = classifyXiaozhiHttp(res.status);
        console.error(
          `[voice] tts_failed engine=xiaozhi category=${failure.category} status=${res.status} attempt=${attempt}`,
        );
        if (failure.retryable && attempt < XIAOZHI_TTS_MAX_ATTEMPTS) continue;
        return { ok: false, kind: failure.kind, engine: "xiaozhi" };
      }

      // Success status — the 8s budget still bounds the body download.
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (error) {
        clearTimeout(timer);
        const isTimeout = error instanceof Error && error.name === "AbortError";
        const failure: XiaozhiFailure = isTimeout
          ? { ok: false, kind: "timeout", category: "timeout", retryable: true }
          : { ok: false, kind: "provider", category: "network", retryable: true };
        console.error(
          `[voice] tts_failed engine=xiaozhi category=${failure.category} attempt=${attempt}`,
        );
        if (failure.retryable && attempt < XIAOZHI_TTS_MAX_ATTEMPTS) continue;
        return { ok: false, kind: failure.kind, engine: "xiaozhi" };
      }
      clearTimeout(timer);

      const mimeType = (res.headers.get("content-type") ?? OUTBOUND_AUDIO_MIME)
        .split(";")[0]!
        .trim()
        .toLowerCase();
      // MIME validation is permanent: the endpoint returned 200 with bytes
      // WhatsApp cannot play (empty file, p3/device-framed Opus, octet-stream).
      // Retrying cannot fix it — fail over immediately.
      if (bytes.byteLength === 0 || !isWhatsappCompatibleAudio(mimeType)) {
        console.error(
          `[voice] tts_failed engine=xiaozhi category=invalid_audio mime=${bytes.byteLength === 0 ? "empty" : mimeType}`,
        );
        return { ok: false, kind: "invalid_audio", engine: "xiaozhi" };
      }
      return { ok: true, bytes, mimeType, engine: "xiaozhi" };
    }
    // Unreachable: every loop path returns or retries.
    return { ok: false, kind: "provider", engine: "xiaozhi" };
  },
};

export const VOICE_ENGINES: Record<VoiceEngineName, VoiceEngine> = {
  openai: openAiVoiceEngine,
  lovable: lovableVoiceEngine,
  xiaozhi: xiaozhiVoiceEngine,
  // POC ONLY — reachable exclusively through an explicit request. Loaded
  // lazily so the driver module never sits in any implicit path.
  get minimax(): VoiceEngine {
    return lazyMinimaxEngine;
  },
};

/**
 * MiniMax Speech 2.8 HD — POC driver, opt-in only. The real implementation
 * lives in ./minimax.server; it is imported inside the handler so this module
 * keeps no static dependency on the POC.
 */
export const lazyMinimaxEngine: VoiceEngine = {
  name: "minimax",
  async synthesize(input) {
    const { minimaxVoiceEngine } = await import("./minimax.server");
    return minimaxVoiceEngine.synthesize(input);
  },
};

/**
 * Legacy constant kept for compatibility only. It is NOT the production
 * fallback: in production (AI_PROVIDER=openai) there is no Lovable failover.
 */
export const FALLBACK_ENGINE_NAME: VoiceEngineName = "lovable";

/** True when the operator pinned the runtime to OpenAI Direct. */
export function isStrictOpenAiMode(): boolean {
  return (process.env["AI_PROVIDER"] ?? "").trim().toLowerCase() === "openai";
}

/**
 * The engine every chain resolves to: OpenAI Direct in production, the
 * optional Lovable gateway only when OpenAI is not configured at all.
 */
export function provenEngine(): VoiceEngine {
  const chain = resolveAudioProviders();
  const primary = chain[0];
  if (primary?.id === "lovable" && !isStrictOpenAiMode()) return lovableVoiceEngine;
  return openAiVoiceEngine;
}

export function selectVoiceEngine(name?: string | null): VoiceEngine {
  const requested = (name ?? process.env["VOICE_TTS_ENGINE"] ?? "").trim().toLowerCase();
  if (requested === "xiaozhi") return xiaozhiVoiceEngine;
  // POC: never selected implicitly — only by explicit name.
  if (requested === "minimax") return lazyMinimaxEngine;
  if (requested === "openai") return openAiVoiceEngine;
  if (requested === "lovable") return lovableVoiceEngine;
  return provenEngine();
}

/**
 * Selected provider first, proven provider second (deduplicated).
 *
 * HARD PRODUCTION RULE: when AI_PROVIDER=openai, OpenAI Direct is the only
 * source of speech. A TTS failure stays a failure (the turn falls back to the
 * already-delivered text answer) — it NEVER silently reroutes to Lovable.
 */
export function selectVoiceProviderChain(name?: string | null): VoiceEngine[] {
  const primary = selectVoiceEngine(name);
  if (isStrictOpenAiMode()) {
    return primary.name === "openai" ? [primary] : [primary, openAiVoiceEngine];
  }
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
      ...(input.language ? { language: input.language } : {}),
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
