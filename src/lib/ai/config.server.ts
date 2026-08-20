/**
 * Provider/model configuration for the AI Intelligence Layer.
 * Server-only. API keys are read at call time and never leave the server.
 */

import { getProviderAdapter, isSupportedProvider } from "./providers.server";

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

const DEFAULT_MODEL = "openai/gpt-5.6-sol";

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
  const provider = env("AI_PROVIDER") ?? "lovable";
  if (!isSupportedProvider(provider)) {
    throw new Error(`AI configuration error: unsupported AI_PROVIDER "${provider}"`);
  }
  const model = env("AI_MODEL") ?? DEFAULT_MODEL;
  return {
    provider,
    model,
    fastModel: env("AI_FAST_MODEL") ?? model,
    // A transient primary-model failure must not end a live sales conversation.
    fallbackModel: env("AI_FALLBACK_MODEL") ?? DEFAULT_FALLBACK_MODEL,
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
