/**
 * UMRAIO® — provider abstraction for AUDIO (speech-to-text + text-to-speech).
 *
 * Mirrors the language-model adapter registry (providers.server.ts) so voice
 * never depends on a single vendor allowance. OpenAI Direct is the production
 * provider; the Lovable AI Gateway remains an OPTIONAL fallback that is only
 * used when its credential is configured.
 *
 * Credentials are read at call time, stay server-side and are never logged or
 * returned.
 */

export type AudioProviderId = "openai" | "lovable";

export type AudioProvider = {
  id: AudioProviderId;
  /** Base URL WITHOUT a trailing slash; endpoints are appended. */
  baseUrl: string;
  headers: () => Record<string, string>;
  transcribeModel: string;
  speechModel: string;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function openAiAudioProvider(): AudioProvider | null {
  const key = env("OPENAI_API_KEY");
  if (!key) return null;
  return {
    id: "openai",
    baseUrl: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    headers: () => ({ Authorization: `Bearer ${key}` }),
    transcribeModel: env("AI_ASR_MODEL") ?? "gpt-4o-transcribe",
    speechModel: env("AI_TTS_MODEL") ?? "gpt-4o-mini-tts",
  };
}

export function lovableAudioProvider(): AudioProvider | null {
  const key = env("LOVABLE_API_KEY");
  if (!key) return null;
  return {
    id: "lovable",
    baseUrl: "https://ai.gateway.lovable.dev/v1",
    headers: () => ({ Authorization: `Bearer ${key}` }),
    transcribeModel: "openai/gpt-4o-transcribe",
    speechModel: "openai/gpt-4o-mini-tts",
  };
}

/**
 * Ordered audio provider chain: the active provider first, the optional
 * Lovable gateway only as a last resort. An explicit AI_PROVIDER always wins,
 * and `openai` never silently falls back to Lovable.
 */
export function resolveAudioProviders(): AudioProvider[] {
  const explicit = env("AI_PROVIDER");
  const openai = openAiAudioProvider();
  const lovable = lovableAudioProvider();

  if (explicit === "openai") return openai ? [openai] : [];
  if (explicit === "lovable") return lovable ? [lovable] : [];

  const chain: AudioProvider[] = [];
  if (openai) chain.push(openai);
  if (lovable) chain.push(lovable);
  return chain;
}

/** Non-secret diagnostic: which audio providers are configured, in order. */
export function describeAudioProviders(): {
  chain: AudioProviderId[];
  primary: AudioProviderId | null;
  transcribeModel: string | null;
  speechModel: string | null;
  ok: boolean;
} {
  const chain = resolveAudioProviders();
  const primary = chain[0] ?? null;
  return {
    chain: chain.map((p) => p.id),
    primary: primary?.id ?? null,
    transcribeModel: primary?.transcribeModel ?? null,
    speechModel: primary?.speechModel ?? null,
    ok: chain.length > 0,
  };
}
