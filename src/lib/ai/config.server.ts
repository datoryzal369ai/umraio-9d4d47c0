/**
 * Provider/model configuration for the AI Intelligence Layer.
 * Server-only. API keys are read at call time and never leave the server.
 */

import { getProviderAdapter, isSupportedProvider, resolveProviderId } from "./providers.server";
import { describeAudioProviders } from "./audio.server";

/** Open by design: providers are resolved through the adapter registry. */
export type AiProviderId = string;

export type AiConfig = {
  provider: AiProviderId;
  /** Primary reasoning model. */
  model: string;
  /** Economical model for fast/classification tasks. */
  fastModel: string;
  /** Optional fallback used when the primary model call fails transiently. */
  fallbackModel: string | null;
  maxRetries: number;
  /** Task-aware request deadlines (ms). */
  timeouts: { fast: number; reasoning: number; evaluation: number };
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function num(name: string, fallback: number): number {
  const parsed = Number(env(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read configuration inside a handler — never at module scope. */
export function getAiConfig(): AiConfig {
  const provider = resolveProviderId();
  if (!isSupportedProvider(provider)) {
    throw new Error(`AI configuration error: unsupported AI_PROVIDER "${provider}"`);
  }
  const adapter = getProviderAdapter(provider);
  const model = env("AI_MODEL") ?? adapter.defaultModel;
  return {
    provider,
    model,
    fastModel: env("AI_FAST_MODEL") ?? adapter.defaultFastModel,
    // Provider-aware: a fallback is only used when it belongs to the active
    // provider, so it can never silently reintroduce another dependency.
    fallbackModel: env("AI_FALLBACK_MODEL") ?? adapter.defaultFallbackModel,
    maxRetries: Math.max(0, Math.min(3, Number(env("AI_MAX_RETRIES") ?? 1) || 0)),
    timeouts: {
      // Long RAIŌ conversations carry a large system prompt; 20s was too tight
      // and surfaced as a 503 on /api/public/meet-executive.
      fast: num("AI_TIMEOUT_FAST_MS", 45_000),
      reasoning: num("AI_TIMEOUT_REASONING_MS", 90_000),
      evaluation: num("AI_TIMEOUT_EVALUATION_MS", 45_000),
    },
  };
}

export function getProviderApiKey(provider: AiProviderId): string {
  return getProviderAdapter(provider).readApiKey();
}

export type AiConfigDiagnostic = {
  provider: AiProviderId;
  providerSource: "explicit" | "resolved";
  model: string;
  fastModel: string;
  fallbackModel: string | null;
  credentialEnvVar: string;
  credentialsConfigured: boolean;
  supportedProviders: string[];
  ok: boolean;
  message: string;
  audio: ReturnType<typeof describeAudioProviders>;
};

/** Non-secret diagnostic: reports provider/model/credential presence only. */
export function describeAiConfig(): AiConfigDiagnostic {
  const supportedProviders = ["openai", "lovable"];
  let config: AiConfig;
  try {
    config = getAiConfig();
  } catch (error) {
    return {
      provider: env("AI_PROVIDER") ?? "unknown",
      providerSource: env("AI_PROVIDER") ? "explicit" : "resolved",
      model: "unknown",
      fastModel: "unknown",
      fallbackModel: null,
      credentialEnvVar: "unknown",
      credentialsConfigured: false,
      supportedProviders,
      ok: false,
      message: error instanceof Error ? error.message : "AI configuration error",
      audio: describeAudioProviders(),
    };
  }

  const adapter = getProviderAdapter(config.provider);
  const credentialsConfigured = adapter.hasCredentials();
  return {
    provider: config.provider,
    providerSource: env("AI_PROVIDER") ? "explicit" : "resolved",
    model: config.model,
    fastModel: config.fastModel,
    fallbackModel: config.fallbackModel,
    credentialEnvVar: adapter.credentialEnvVar,
    credentialsConfigured,
    supportedProviders,
    ok: credentialsConfigured,
    message: credentialsConfigured
      ? `Provider "${config.provider}" configured.`
      : `AI configuration error: missing ${adapter.credentialEnvVar}`,
    audio: describeAudioProviders(),
  };
}
