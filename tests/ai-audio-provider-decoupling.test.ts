import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeAudioProviders, resolveAudioProviders } from "@/lib/ai/audio.server";
import { transcribeAudio } from "@/lib/voice/asr.server";
import { provenEngine, selectVoiceProviderChain, synthesizeSpeech } from "@/lib/voice/tts.server";

const realFetch = globalThis.fetch;
const saved = { ...process.env };

beforeEach(() => {
  delete process.env["AI_PROVIDER"];
  delete process.env["OPENAI_API_KEY"];
  delete process.env["LOVABLE_API_KEY"];
  delete process.env["VOICE_TTS_ENGINE"];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("AI audio provider decoupling", () => {
  it("prefers OpenAI Direct and keeps Lovable as optional fallback only", () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["LOVABLE_API_KEY"] = "lov-test";
    expect(resolveAudioProviders().map((p) => p.id)).toEqual(["openai", "lovable"]);
    expect(describeAudioProviders().primary).toBe("openai");
    expect(provenEngine().name).toBe("openai");
  });

  it("AI_PROVIDER=openai never falls back to Lovable", () => {
    process.env["AI_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["LOVABLE_API_KEY"] = "lov-test";
    expect(resolveAudioProviders().map((p) => p.id)).toEqual(["openai"]);
    expect(selectVoiceProviderChain().map((e) => e.name)).toEqual(["openai"]);
  });

  it("reports a configuration failure when no audio provider is configured", async () => {
    expect(describeAudioProviders().ok).toBe(false);
    const result = await transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, kind: "config", status: null });
  });

  it("TTS calls OpenAI Direct with the bare model id and leaks no secret", async () => {
    process.env["OPENAI_API_KEY"] = "sk-secret";
    let url = "";
    let body = "";
    globalThis.fetch = vi.fn(async (u: unknown, init: unknown) => {
      url = String(u);
      body = String((init as RequestInit).body);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await synthesizeSpeech({ text: "Salam" });
    expect(result.ok && result.engine).toBe("openai");
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(body).toContain('"model":"gpt-4o-mini-tts"');
    expect(body).not.toContain("sk-secret");
  });

  it("ASR entitlement failure on the primary provider fails over to the fallback", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["LOVABLE_API_KEY"] = "lov-test";
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: unknown) => {
      urls.push(String(u));
      if (String(u).includes("api.openai.com")) return new Response("no credit", { status: 402 });
      return new Response(JSON.stringify({ text: "Assalamualaikum" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" });
    expect(result.ok && result.text).toBe("Assalamualaikum");
    expect(urls).toHaveLength(2);
  });

  it("invalid audio is terminal and is not retried on another provider", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["LOVABLE_API_KEY"] = "lov-test";
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: unknown) => {
      urls.push(String(u));
      return new Response("bad audio", { status: 400 });
    }) as unknown as typeof fetch;

    const result = await transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" });
    expect(result).toEqual({ ok: false, kind: "invalid_audio", status: 400 });
    expect(urls).toHaveLength(1);
  });
});

describe("exact payload reaching /v1/audio/speech for a WhatsApp voice note", () => {
  it("sends the prepared conversational script with the documented config", async () => {
    process.env["AI_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-secret";
    let url = "";
    let payload: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (u: unknown, init: unknown) => {
      url = String(u);
      payload = JSON.parse(String((init as RequestInit).body));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const { prepareSpokenResponse } = await import("@/lib/voice/presentation.core");
    const spoken = prepareSpokenResponse({
      replyText:
        "Ya, untuk pakej September ni harganya RM9,800 seorang. Hotel pun dekat dengan Haram. Kalau Datuk nak, saya boleh semak tarikh yang masih ada.",
      language: "ms-MY",
    });

    const result = await synthesizeSpeech({
      text: spoken.spokenText,
      voice: spoken.voice,
      speed: spoken.speed,
      instructions: spoken.instructions,
    });

    expect(result.ok && result.engine).toBe("openai");
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(payload["model"]).toBe("gpt-4o-mini-tts");
    expect(payload["voice"]).toBe("marin");
    expect(payload["speed"]).toBe(0.97);
    expect(payload["response_format"]).toBe("opus");
    expect(String(payload["instructions"]).toLowerCase()).toContain("malaysian");
    // The EXACT text sent to TTS: conversational, no markdown, no RM symbol.
    expect(String(payload["input"])).toContain("sembilan ribu lapan ratus ringgit");
    expect(String(payload["input"])).not.toMatch(/RM|[*#_`]/);
    expect((String(payload["input"]).match(/Datuk/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});
