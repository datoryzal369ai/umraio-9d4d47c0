/**
 * UMRAIO® VOICE REPLY V1 — server-only speech synthesis.
 *
 * ENGINE-AGNOSTIC BY DESIGN. `VoiceEngine` is the only contract the pipeline
 * knows about; today one driver is registered (Lovable AI voice). A XiaoZhi
 * driver can be added later by implementing the same interface and selecting
 * it with VOICE_TTS_ENGINE — no caller changes.
 *
 * SECURITY: credentials stay in this module, are never logged and never
 * returned. Audio bytes are held in memory only and never persisted.
 */

export type VoiceEngineName = "lovable" | "xiaozhi";

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

export type VoiceEngine = {
  name: VoiceEngineName;
  synthesize(input: { text: string; voice?: string }): Promise<TtsResult>;
};

/** WhatsApp voice notes must be Opus in an OGG container. */
export const OUTBOUND_AUDIO_MIME = "audio/ogg";

const LOVABLE_TTS_ENDPOINT = "https://ai.gateway.lovable.dev/v1/audio/speech";
export const LOVABLE_TTS_MODEL = "openai/gpt-4o-mini-tts";
export const DEFAULT_VOICE = "alloy";

function classify(status: number): TtsFailureKind {
  if (status === 400 || status === 404) return "invalid_request";
  if (status === 401) return "config";
  if (status === 402 || status === 403) return "entitlement";
  if (status === 429) return "rate_limited";
  return "provider";
}

export const lovableVoiceEngine: VoiceEngine = {
  name: "lovable",
  async synthesize({ text, voice }) {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) {
      console.error("[voice] xiaozhi_tts_failed category=config engine=lovable");
      return { ok: false, kind: "config", engine: "lovable" };
    }
    let res: Response;
    try {
      res = await fetch(LOVABLE_TTS_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LOVABLE_TTS_MODEL,
          input: text,
          voice: voice ?? DEFAULT_VOICE,
          // Complete OGG/Opus file — exactly what Meta accepts as a voice note.
          response_format: "opus",
          instructions:
            "You are a warm, confident Malaysian Umrah travel executive speaking Bahasa Melayu on a WhatsApp voice note. Speak conversationally, not like a news reader: unhurried pace, gentle warmth, natural rises and falls, a short breath at commas and a real pause at full stops. Pronounce Malay words with Malaysian pronunciation and Arabic terms respectfully. Never spell out punctuation, symbols, links or reference codes.",

        }),
      });
    } catch (error) {
      console.error(
        `[voice] xiaozhi_tts_failed category=network name=${error instanceof Error ? error.name : "unknown"}`,
      );
      return { ok: false, kind: "provider", engine: "lovable" };
    }

    if (!res.ok) {
      const kind = classify(res.status);
      console.error(`[voice] xiaozhi_tts_failed category=${kind} status=${res.status}`);
      return { ok: false, kind, engine: "lovable" };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      console.error("[voice] xiaozhi_tts_failed category=empty_audio");
      return { ok: false, kind: "provider", engine: "lovable" };
    }
    return { ok: true, bytes, mimeType: OUTBOUND_AUDIO_MIME, engine: "lovable" };
  },
};

/**
 * Placeholder driver. UMRAIO has no XiaoZhi credentials or endpoint contract
 * today, so selecting it fails cleanly (and the caller falls back to text)
 * instead of pretending to speak.
 */
export const xiaozhiVoiceEngine: VoiceEngine = {
  name: "xiaozhi",
  async synthesize() {
    console.error("[voice] xiaozhi_tts_failed category=unsupported_engine");
    return { ok: false, kind: "unsupported_engine", engine: "xiaozhi" };
  },
};

export function selectVoiceEngine(name?: string | null): VoiceEngine {
  const requested = (name ?? process.env["VOICE_TTS_ENGINE"] ?? "lovable").trim().toLowerCase();
  if (requested === "xiaozhi") return xiaozhiVoiceEngine;
  return lovableVoiceEngine;
}

export async function synthesizeSpeech(input: {
  text: string;
  voice?: string;
  engine?: VoiceEngine;
}): Promise<TtsResult> {
  const engine = input.engine ?? selectVoiceEngine();
  const started = Date.now();
  const result = await engine.synthesize(
    input.voice ? { text: input.text, voice: input.voice } : { text: input.text },
  );
  if (result.ok) {
    console.log(
      `[voice] xiaozhi_tts_success engine=${engine.name} bytes=${result.bytes.byteLength} latency_ms=${Date.now() - started}`,
    );
  }
  return result;
}
