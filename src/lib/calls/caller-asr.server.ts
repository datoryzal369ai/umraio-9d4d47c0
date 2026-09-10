import { resolveAudioProviders } from "@/lib/ai/audio.server";

export type CallerAsr = { text: string; durationSeconds: number | null; language: string | null;
  confidence: "unknown"; provider: string; model: string };

/** Calling-local cancellation adapter. Resolves the existing provider/model; no Voice Note implementation imports. */
export async function transcribeCaller(input: { bytes: Uint8Array; language: string; signal: AbortSignal }): Promise<CallerAsr> {
  const providers = resolveAudioProviders();
  if (!providers.length) throw new Error("calling_asr_config");
  for (const provider of providers) {
    input.signal.throwIfAborted();
    const form = new FormData();
    form.append("file", new Blob([input.bytes.slice()], { type: "audio/ogg" }), "calling.ogg");
    form.append("model", provider.transcribeModel);
    const code = input.language.toLowerCase().split("-")[0]!;
    const hint = code === "auto" ? null : ["ms", "en", "ar", "id", "zh", "ta", "ur", "bn"].includes(code) ? code : "ms";
    if (hint) form.append("language", hint);
    const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
      method: "POST", headers: provider.headers(), body: form, signal: input.signal,
    });
    if (!response.ok) {
      // Preserve existing configured provider ordering. No new provider, retry or credentials.
      if ([400, 404].includes(response.status)) throw new Error(`calling_asr_invalid_audio_${response.status}`);
      if (provider !== providers.at(-1)) continue;
      throw new Error(`calling_asr_http_${response.status}`);
    }
    const body = await response.json() as { text?: unknown; usage?: { seconds?: unknown }; duration?: unknown };
    // Preserve exact provider transcript; whitespace trimming is solely an emptiness check.
    if (typeof body.text !== "string" || !body.text.trim()) throw new Error("calling_asr_empty_transcript");
    const duration = body.usage?.seconds ?? body.duration;
    return { text: body.text, durationSeconds: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
      language: hint ?? null, confidence: "unknown", provider: provider.id, model: provider.transcribeModel };
  }
  throw new Error("calling_asr_unavailable");
}
