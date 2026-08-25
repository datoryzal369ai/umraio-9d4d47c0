import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_ENGINE_NAME,
  isWhatsappCompatibleAudio,
  lovableVoiceEngine,
  selectVoiceEngine,
  selectVoiceProviderChain,
  synthesizeSpeech,
  xiaozhiVoiceEngine,
} from "@/lib/voice/tts.server";
import { VOICE_PERSONAS } from "@/lib/voice/persona.core";
import { buildVoiceInstructions } from "@/lib/voice/persona.core";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["XIAOZHI_TTS_URL"];
  delete process.env["XIAOZHI_TTS_API_KEY"];
  delete process.env["VOICE_TTS_ENGINE"];
  delete process.env["AI_PROVIDER"];
  vi.restoreAllMocks();
});

describe("VOICE V3 — provider layer", () => {
  it("defaults to OpenAI Direct when it is the configured provider", () => {
    process.env["AI_PROVIDER"] = "openai";
    expect(selectVoiceEngine().name).toBe("openai");
    expect(selectVoiceProviderChain().map((e) => e.name)).toEqual(["openai"]);
  });

  it("defaults to the proven provider and never chains it twice", () => {
    process.env["AI_PROVIDER"] = "lovable";
    process.env["LOVABLE_API_KEY"] = "test-key";
    expect(selectVoiceEngine().name).toBe("lovable");
    expect(selectVoiceProviderChain().map((e) => e.name)).toEqual(["lovable"]);
  });

  it("selecting XiaoZhi always keeps the proven provider as fallback", () => {
    process.env["AI_PROVIDER"] = "lovable";
    process.env["LOVABLE_API_KEY"] = "test-key";
    expect(selectVoiceProviderChain("xiaozhi").map((e) => e.name)).toEqual([
      "xiaozhi",
      FALLBACK_ENGINE_NAME,
    ]);
  });

  it("XiaoZhi stays inert until a self-hosted endpoint is configured", async () => {
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "unsupported_engine", engine: "xiaozhi" });
  });

  it("TEST E — XiaoZhi unavailable falls back to the proven provider and still delivers audio", async () => {
    process.env["AI_PROVIDER"] = "lovable";
    process.env["LOVABLE_API_KEY"] = "test-key";
    process.env["XIAOZHI_TTS_URL"] = "https://xiaozhi.internal/tts";
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("xiaozhi")) return new Response("down", { status: 503 });
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;

    const result = await synthesizeSpeech({ text: "Salam Datuk", provider: "xiaozhi" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.engine).toBe("lovable");
      expect(result.mimeType).toBe("audio/ogg");
    }
    expect(calls).toHaveLength(2);
  });

  it("a configured XiaoZhi endpoint is used first when it returns WhatsApp-compatible audio", async () => {
    process.env["XIAOZHI_TTS_URL"] = "https://xiaozhi.internal/tts";
    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array([9, 9, 9]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      }),
    ) as unknown as typeof fetch;
    const result = await synthesizeSpeech({ text: "Salam", provider: "xiaozhi" });
    expect(result.ok && result.engine).toBe("xiaozhi");
  });

  it("device-framed / incompatible audio is rejected instead of being uploaded to WhatsApp", async () => {
    process.env["XIAOZHI_TTS_URL"] = "https://xiaozhi.internal/tts";
    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    ) as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "invalid_request", engine: "xiaozhi" });
    expect(isWhatsappCompatibleAudio("audio/ogg")).toBe(true);
    expect(isWhatsappCompatibleAudio("audio/wav")).toBe(false);
  });

  it("the proven provider still returns OGG and never leaks credentials", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    let body = "";
    globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
      body = String((init as RequestInit).body);
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await synthesizeSpeech({ text: "Salam", engine: lovableVoiceEngine });
    expect(result.ok && result.mimeType).toBe("audio/ogg");
    expect(body).toContain('"response_format":"opus"');
    expect(body).not.toContain("test-key");
  });

  it("natural voice presets and steering are warm, conversational and non-robotic", () => {
    expect(VOICE_PERSONAS.premium_sales_executive.voice).toBe("sage");
    const instructions = buildVoiceInstructions(
      VOICE_PERSONAS.premium_sales_executive.controls,
      "ms-MY",
    ).toLowerCase();
    expect(instructions).toContain("malaysian malay");
    expect(instructions).toContain("no robotic pronunciation");
    expect(instructions).toContain("no monotone");
  });
});
