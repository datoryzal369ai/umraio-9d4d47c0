/**
 * UMRAIO® VOICE V1 — server-only speech-to-text.
 *
 * The transcript IS the customer message: no translation, no summarising, no
 * fabricated content. On any failure we return a typed error and the caller
 * sends an honest fallback — never a guessed sales answer, and never a claim
 * that voice notes are unsupported (they are supported).
 *
 * Failure taxonomy (kept distinct on purpose — the customer wording and the
 * server diagnostics differ per kind):
 *   config           — no provider credential configured,
 *   invalid_audio    — provider rejected the file (400/404): format/decode,
 *   empty_transcript — provider succeeded but heard nothing intelligible,
 *   rate_limited     — 429 after bounded retry,
 *   entitlement      — 402/403,
 *   provider         — network / timeout / 5xx / malformed response.
 */
import { asrLanguageFor } from "./language.core";
import { isEffectivelyEmptyTranscript, normalizeTranscript } from "./limits.core";
import { resolveAudioProviders, type AudioProvider } from "@/lib/ai/audio.server";

/** Legacy id kept for reference; the active model comes from the provider. */
export const ASR_MODEL = "openai/gpt-4o-transcribe";

/** Hard ceiling for one transcription HTTP call. */
export const ASR_TIMEOUT_MS = 30_000;

/** Bounded attempts per provider — transient failures only, never infinite. */
export const ASR_MAX_ATTEMPTS = 3;

export type AsrErrorKind =
  | "config"
  | "rate_limited"
  | "entitlement"
  | "invalid_audio"
  | "empty_transcript"
  | "provider";

export type AsrResult =
  | { ok: true; text: string; durationSeconds: number | null }
  | { ok: false; kind: AsrErrorKind; status: number | null };

/**
 * Candidate file extensions per container. The first is the accurate one; the
 * remainder are equivalent aliases the transcription endpoint also accepts, and
 * are only tried when the provider rejects the upload with a 400 (some stacks
 * key format detection off the filename alone).
 */
const EXT_CANDIDATES: Record<string, string[]> = {
  "audio/ogg": ["ogg", "oga"],
  "audio/opus": ["ogg", "oga"],
  "audio/mpeg": ["mp3"],
  "audio/mp3": ["mp3"],
  "audio/mp4": ["mp4", "m4a"],
  "audio/m4a": ["m4a", "mp4"],
  "audio/x-m4a": ["m4a", "mp4"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/webm": ["webm"],
  "audio/aac": ["aac", "m4a"],
  "audio/flac": ["flac"],
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reads the transcript out of the transcription response, tolerating the
 * documented JSON shape and the small variations providers ship. Returns null
 * when the payload carries no transcript field at all (malformed response),
 * which is a PROVIDER failure — never "the customer said nothing".
 */
export function extractTranscript(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record["text"] === "string") return record["text"];
  const data = record["data"];
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>)["text"] === "string") {
    return (data as Record<string, string>)["text"]!;
  }
  const segments = record["segments"];
  if (Array.isArray(segments)) {
    const joined = segments
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>)["text"] : null))
      .filter((t): t is string => typeof t === "string")
      .join(" ");
    if (joined.trim()) return joined;
  }
  return null;
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
  const providers = resolveAudioProviders();
  if (providers.length === 0) {
    console.error("[voice] asr_failure category=config");
    return { ok: false, kind: "config", status: null };
  }

  let last: AsrResult = { ok: false, kind: "provider", status: null };
  for (const provider of providers) {
    const result = await transcribeWith(provider, input);
    if (result.ok) return result;
    last = result;
    // Terminal, audio-scoped outcomes would fail identically on every provider.
    if (result.kind === "invalid_audio" || result.kind === "empty_transcript") return result;
    console.error(`[voice] asr_failover provider=${provider.id} category=${result.kind}`);
  }
  return last;
}

async function transcribeWith(
  provider: AudioProvider,
  input: { bytes: Uint8Array; mimeType: string; language?: string | null },
): Promise<AsrResult> {
  const base = (input.mimeType || "").split(";")[0]!.trim().toLowerCase();
  const candidates = EXT_CANDIDATES[base] ?? ["ogg"];
  const endpoint = `${provider.baseUrl}/audio/transcriptions`;

  let lastStatus: number | null = null;
  let extIndex = 0;

  for (let attempt = 1; attempt <= ASR_MAX_ATTEMPTS; attempt += 1) {
    const ext = candidates[Math.min(extIndex, candidates.length - 1)]!;
    // A fresh Blob per attempt — a consumed body can never be re-sent.
    const blob = new Blob([input.bytes.slice() as unknown as BlobPart], {
      type: base || "audio/ogg",
    });
    const form = new FormData();
    form.append("model", provider.transcribeModel);
    form.append("file", blob, `voice-note.${ext}`);
    const asrLanguage = input.language === undefined ? null : asrLanguageFor(input.language);
    if (asrLanguage) form.append("language", asrLanguage);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        // Never set Content-Type manually — the runtime sets the boundary.
        headers: provider.headers(),
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      lastStatus = null;
      console.error(
        `[voice] asr_failure provider=${provider.id} category=${timedOut ? "timeout" : "network"} attempt=${attempt} ext=${ext}`,
      );
      if (attempt < ASR_MAX_ATTEMPTS) {
        await sleep(400 * attempt);
        continue;
      }
      return { ok: false, kind: "provider", status: null };
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const payload = (await res.json().catch(() => null)) as unknown;
      const raw = extractTranscript(payload);
      if (raw === null) {
        // Malformed / unparseable success body — a PIPELINE fault, retryable.
        console.error(
          `[voice] asr_failure provider=${provider.id} category=malformed_response attempt=${attempt}`,
        );
        if (attempt < ASR_MAX_ATTEMPTS) {
          await sleep(300 * attempt);
          continue;
        }
        return { ok: false, kind: "provider", status: res.status };
      }
      const text = normalizeTranscript(raw);
      if (isEffectivelyEmptyTranscript(text)) {
        // The provider heard nothing intelligible. That is NOT a broken pipeline
        // and NOT "voice notes unsupported" — the customer is asked to resend.
        console.error(
          `[voice] asr_failure provider=${provider.id} category=empty_transcript raw_chars=${raw.length}`,
        );
        return { ok: false, kind: "empty_transcript", status: res.status };
      }
      const usage = (payload as { usage?: { seconds?: number } } | null)?.usage;
      const seconds =
        typeof usage?.seconds === "number" && usage.seconds > 0 ? Math.round(usage.seconds) : null;
      console.log(`[voice] asr_success provider=${provider.id} chars=${text.length}`);
      return { ok: true, text, durationSeconds: seconds };
    }

    lastStatus = res.status;
    if (res.status === 400 || res.status === 404) {
      // Try the equivalent container alias exactly once before giving up: some
      // stacks reject `.ogg` naming for an otherwise valid Opus payload.
      if (res.status === 400 && extIndex < candidates.length - 1 && attempt < ASR_MAX_ATTEMPTS) {
        extIndex += 1;
        console.error(
          `[voice] asr_retry provider=${provider.id} category=format status=400 next_ext=${candidates[extIndex]}`,
        );
        continue;
      }
      console.error(
        `[voice] asr_failure provider=${provider.id} category=invalid_audio status=${res.status} ext=${ext}`,
      );
      return { ok: false, kind: "invalid_audio", status: res.status };
    }
    if (res.status === 401) {
      console.error(`[voice] asr_failure provider=${provider.id} category=config status=401`);
      return { ok: false, kind: "config", status: 401 };
    }
    if (res.status === 402 || res.status === 403) {
      console.error(`[voice] asr_failure provider=${provider.id} category=entitlement status=${res.status}`);
      return { ok: false, kind: "entitlement", status: res.status };
    }

    // 429 / 5xx — bounded backoff, then graceful fallback.
    if (attempt < ASR_MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt;
      console.error(
        `[voice] asr_retry provider=${provider.id} category=transient status=${res.status} attempt=${attempt}`,
      );
      await sleep(Math.min(waitMs, 3_000));
      continue;
    }
    console.error(
      `[voice] asr_failure provider=${provider.id} category=${res.status === 429 ? "rate_limited" : "provider"} status=${res.status}`,
    );
    return {
      ok: false,
      kind: res.status === 429 ? "rate_limited" : "provider",
      status: res.status,
    };
  }

  return { ok: false, kind: "provider", status: lastStatus };
}
