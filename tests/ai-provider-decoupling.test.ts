import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { getAiConfig, describeAiConfig } from "@/lib/ai/config.server";
import { getProviderAdapter, resolveProviderId, isSupportedProvider } from "@/lib/ai/providers.server";

const KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_FAST_MODEL",
  "AI_FALLBACK_MODEL",
  "OPENAI_API_KEY",
  "LOVABLE_API_KEY",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("provider selection", () => {
  it("prefers OpenAI Direct when OPENAI_API_KEY is present", () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    expect(resolveProviderId()).toBe("openai");
    expect(getAiConfig().provider).toBe("openai");
  });

  it("uses Lovable only when explicitly configured or as the sole credential", () => {
    process.env["LOVABLE_API_KEY"] = "lov-test";
    expect(resolveProviderId()).toBe("lovable");

    process.env["OPENAI_API_KEY"] = "sk-test";
    expect(resolveProviderId()).toBe("openai");

    process.env["AI_PROVIDER"] = "lovable";
    expect(resolveProviderId()).toBe("lovable");
  });

  it("supports both adapters and rejects unknown providers", () => {
    expect(isSupportedProvider("openai")).toBe(true);
    expect(isSupportedProvider("lovable")).toBe(true);
    expect(isSupportedProvider("acme")).toBe(false);
    expect(() => getProviderAdapter("acme")).toThrow(/unsupported AI_PROVIDER/);
  });
});

describe("model configuration", () => {
  it("uses provider defaults and honours AI_MODEL / AI_FAST_MODEL", () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    let config = getAiConfig();
    expect(config.model).toBe("gpt-4.1");
    expect(config.fastModel).toBe("gpt-4.1-mini");

    process.env["AI_MODEL"] = "gpt-4.1-mini";
    process.env["AI_FAST_MODEL"] = "gpt-4.1-nano";
    config = getAiConfig();
    expect(config.model).toBe("gpt-4.1-mini");
    expect(config.fastModel).toBe("gpt-4.1-nano");
  });

  it("never falls back to a Lovable model when running on OpenAI", () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    expect(getAiConfig().fallbackModel).toBeNull();

    process.env["AI_FALLBACK_MODEL"] = "gpt-4.1-mini";
    expect(getAiConfig().fallbackModel).toBe("gpt-4.1-mini");
  });
});

describe("configuration failure", () => {
  it("fails clearly when the provider credential is missing", () => {
    process.env["AI_PROVIDER"] = "openai";
    expect(() => getProviderAdapter("openai").readApiKey()).toThrow(
      /AI configuration error: missing OPENAI_API_KEY/,
    );
  });

  it("diagnostic reports provider/model and credential presence without secrets", () => {
    process.env["AI_PROVIDER"] = "openai";
    let diagnostic = describeAiConfig();
    expect(diagnostic.ok).toBe(false);
    expect(diagnostic.credentialsConfigured).toBe(false);
    expect(diagnostic.credentialEnvVar).toBe("OPENAI_API_KEY");
    expect(JSON.stringify(diagnostic)).not.toContain("sk-test");

    process.env["OPENAI_API_KEY"] = "sk-test";
    diagnostic = describeAiConfig();
    expect(diagnostic.ok).toBe(true);
    expect(diagnostic.provider).toBe("openai");
    expect(diagnostic.model).toBe("gpt-4.1");
    expect(JSON.stringify(diagnostic)).not.toContain("sk-test");
  });
});
