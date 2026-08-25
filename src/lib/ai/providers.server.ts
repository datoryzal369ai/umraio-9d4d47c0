import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import type { AiProviderId } from "./config.server";

/**
 * Provider adapter registry.
 *
 * The neutral gateway depends on this interface only — never on a concrete
 * provider SDK. A future RÉNAIO.CORE™ engine registers its own adapter here and
 * the gateway keeps working unchanged. All provider-specific request options
 * live inside the adapter, never in the neutral gateway.
 *
 * Lovable is NOT a mandatory runtime dependency: it is one optional adapter
 * among others and is only selected when explicitly configured.
 */

export type ProviderTransport = "fast" | "reasoning";

export type ProviderAdapter = {
  id: string;
  /** Throws a clear configuration error when credentials are missing. */
  readApiKey: () => string;
  /** True when this adapter's credentials are present (no secret is exposed). */
  hasCredentials: () => boolean;
  /** Name of the environment variable holding this provider's credential. */
  credentialEnvVar: string;
  /** Default primary/fast model ids for this provider. */
  defaultModel: string;
  defaultFastModel: string;
  /** Provider-scoped fallback model, or null when none is safe by default. */
  defaultFallbackModel: string | null;
  /** Build a model handle for the given transport class. */
  model: (modelId: string, transport: ProviderTransport) => LanguageModel;
  /** Provider-specific request options for a transport class. */
  requestOptions: (transport: ProviderTransport) => Record<string, unknown> | undefined;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

const LOVABLE_BASE_URL = "https://ai.gateway.lovable.dev/v1";

/** OpenAI ids on the Lovable gateway use the Responses transport. */
function isOpenAiModel(modelId: string) {
  return modelId.startsWith("openai/");
}

/* ------------------------------------------------------------------ */
/* OpenAI Direct — production default when OPENAI_API_KEY is configured */
/* ------------------------------------------------------------------ */

/** Strip any gateway-style vendor prefix: OpenAI Direct takes bare model ids. */
function bareOpenAiModelId(modelId: string): string {
  return modelId.startsWith("openai/") ? modelId.slice("openai/".length) : modelId;
}

const openAiAdapter: ProviderAdapter = {
  id: "openai",
  credentialEnvVar: "OPENAI_API_KEY",
  // Current, production-safe Responses API model ids.
  defaultModel: "gpt-4.1",
  defaultFastModel: "gpt-4.1-mini",
  // No implicit fallback: a fallback must be configured explicitly so it can
  // never silently reintroduce another provider dependency.
  defaultFallbackModel: null,
  hasCredentials() {
    return Boolean(env("OPENAI_API_KEY"));
  },
  readApiKey() {
    const key = env("OPENAI_API_KEY");
    if (!key) throw new Error("AI configuration error: missing OPENAI_API_KEY");
    return key;
  },
  model(modelId) {
    const openai = createOpenAI({ apiKey: this.readApiKey() });
    return openai.responses(bareOpenAiModelId(modelId));
  },
  requestOptions(transport) {
    if (transport === "reasoning") {
      return { openai: { store: false } };
    }
    return { openai: { store: false } };
  },
};

/* ------------------------------------------------------------------ */
/* Lovable AI Gateway — optional, explicitly configured only            */
/* ------------------------------------------------------------------ */

const lovableAdapter: ProviderAdapter = {
  id: "lovable",
  credentialEnvVar: "LOVABLE_API_KEY",
  defaultModel: "openai/gpt-5.6-sol",
  defaultFastModel: "openai/gpt-5.6-sol",
  defaultFallbackModel: "google/gemini-2.5-flash",
  hasCredentials() {
    return Boolean(env("LOVABLE_API_KEY"));
  },
  readApiKey() {
    const key = env("LOVABLE_API_KEY");
    if (!key) throw new Error("AI configuration error: missing LOVABLE_API_KEY");
    return key;
  },
  model(modelId, transport) {
    const apiKey = this.readApiKey();
    const headers = {
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    };

    if (transport === "reasoning" && isOpenAiModel(modelId)) {
      // OpenAI reasoning models are only correctly supported on /v1/responses.
      const openai = createOpenAI({ baseURL: LOVABLE_BASE_URL, apiKey, headers });
      return openai.responses(modelId);
    }

    return createOpenAICompatible({
      name: "lovable",
      baseURL: LOVABLE_BASE_URL,
      supportsStructuredOutputs: true,
      headers,
    })(modelId);
  },
  requestOptions(transport) {
    if (transport === "reasoning") {
      return {
        openai: {
          forceReasoning: true,
          reasoningEffort: "medium",
          reasoningSummary: "auto",
          store: false,
          include: ["reasoning.encrypted_content"],
        },
      };
    }
    return { lovable: { reasoningEffort: "none" } };
  },
};

const ADAPTERS = new Map<string, ProviderAdapter>([
  [openAiAdapter.id, openAiAdapter],
  [lovableAdapter.id, lovableAdapter],
]);

export function registerProviderAdapter(adapter: ProviderAdapter) {
  ADAPTERS.set(adapter.id, adapter);
}

export function isSupportedProvider(id: string): id is AiProviderId {
  return ADAPTERS.has(id);
}

export function listProviderIds(): string[] {
  return [...ADAPTERS.keys()];
}

export function getProviderAdapter(id: string): ProviderAdapter {
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new Error(
      `AI configuration error: unsupported AI_PROVIDER "${id}". Supported: ${[...ADAPTERS.keys()].join(", ")}`,
    );
  }
  return adapter;
}

/**
 * Resolve the active provider id.
 *
 * Explicit AI_PROVIDER always wins. Otherwise OpenAI Direct is preferred when
 * its credential is present; Lovable is only used as a legacy last resort when
 * it is the only configured provider.
 */
export function resolveProviderId(): string {
  const explicit = env("AI_PROVIDER");
  if (explicit) return explicit;
  if (openAiAdapter.hasCredentials()) return openAiAdapter.id;
  if (lovableAdapter.hasCredentials()) return lovableAdapter.id;
  return openAiAdapter.id; // fail as configuration, not silently on Lovable
}
