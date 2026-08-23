/**
 * UMRAIO® VOICE V1 — server-only speech-to-text.
 *
 * The transcript IS the customer message: no translation, no summarising, no
 * fabricated content. On any failure we return a typed error and the caller
 * sends an honest fallback — never a guessed sales answer.
 */
import { asrLanguageFor } from "./language.core";
import { normalizeTranscript } from "./limits.core";

export const ASR_MODEL = "openai/gpt-4o-transcribe";
const ASR_ENDPOINT = "https://ai.gateway.lovable.dev/v1/audio/transcriptions";

export type AsrErrorKind = "config" | "rate_limited" | "entitlement" | "invalid_audio" | "provider";

export type AsrResult =
  | { ok: true; text: string; durationSeconds: number | null }
  | { ok: false; kind: AsrErrorKind; status: number | null };

const EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Language handling: the agency's `voice_language` supplies an ISO-639-1 hint
 * that the transcription model accepts (`language`). For "auto" — or any
 * unknown value — the parameter is omitted and the model auto-detects, which
 * keeps mixed Malay-English speech transcribed as spoken. No unsupported
 * parameter is ever invented.
 */
export async function transcribeAudio(input: {
  bytes: Uint8Array;
  mimeType: string;
  language?: string | null;
}): Promise<AsrResult> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) {
    console.error("[voice] asr_failure category=config");
    return { ok: false, kind: "config", status: null };
  }

  const base = input.mimeType.split(";")[0]!.trim().toLowerCase();
  const ext = EXT[base] ?? "ogg";
  const blob = new Blob([input.bytes.slice() as unknown as BlobPart], { type: base || "audio/ogg" });

  const maxAttempts = 3;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const form = new FormData();
    form.append("model", ASR_MODEL);
    form.append("file", blob, `voice-note.${ext}`);
    const asrLanguage = input.language === undefined ? null : asrLanguageFor(input.language);
    if (asrLanguage) form.append("language", asrLanguage);

    let res: Response;
    try {
      res = await fetch(ASR_ENDPOINT, {
        method: "POST",
        // Never set Content-Type manually — the runtime sets the boundary.
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } catch (error) {
      lastStatus = null;
      console.error(`[voice] asr_failure category=network attempt=${attempt} name=${error instanceof Error ? error.name : "unknown"}`);
      if (attempt < maxAttempts) {
        await sleep(400 * attempt);
        continue;
      }
      return { ok: false, kind: "provider", status: null };
    }

    if (res.ok) {
      const payload = (await res.json().catch(() => null)) as
        | { text?: string; usage?: { seconds?: number; input_tokens?: number } }
        | null;
      const text = normalizeTranscript(payload?.text ?? "");
      if (!text) {
        console.error("[voice] asr_failure category=empty_transcript");
        return { ok: false, kind: "invalid_audio", status: res.status };
      }
      const seconds =
        typeof payload?.usage?.seconds === "number" && payload.usage.seconds > 0
          ? Math.round(payload.usage.seconds)
          : null;
      return { ok: true, text, durationSeconds: seconds };
    }

    lastStatus = res.status;
    // Terminal statuses: never retried, never surfaced to the customer.
    if (res.status === 400 || res.status === 404) {
      console.error(`[voice] asr_failure category=invalid_audio status=${res.status}`);
      return { ok: false, kind: "invalid_audio", status: res.status };
    }
    if (res.status === 401) {
      console.error("[voice] asr_failure category=config status=401");
      return { ok: false, kind: "config", status: 401 };
    }
    if (res.status === 402 || res.status === 403) {
      console.error(`[voice] asr_failure category=entitlement status=${res.status}`);
      return { ok: false, kind: "entitlement", status: res.status };
    }

    // 429 / 5xx — bounded backoff, then graceful fallback.
    if (attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt;
      await sleep(Math.min(waitMs, 3_000));
      continue;
    }
    console.error(`[voice] asr_failure category=${res.status === 429 ? "rate_limited" : "provider"} status=${res.status}`);
    return {
      ok: false,
      kind: res.status === 429 ? "rate_limited" : "provider",
      status: res.status,
    };
  }

  return { ok: false, kind: "provider", status: lastStatus };
}
