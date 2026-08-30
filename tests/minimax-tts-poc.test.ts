import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hexToBytes, minimaxVoiceEngine, resolveMinimaxConfig } from "@/lib/voice/minimax.server";
import { selectVoiceEngine, synthesizeSpeech } from "@/lib/voice/tts.server";

const realFetch = globalThis.fetch;
const saved = { ...process.env };

beforeEach(() => {
  for (const key of [
    "MINIMAX_API_KEY",
    "MINIMAX_TTS_MODEL",
    "MINIMAX_TTS_VOICE_ID",
    "MINIMAX_GROUP_ID",
    "VOICE_TTS_ENGINE",
    "AI_PROVIDER",
    "OPENAI_API_KEY",
    "LOVABLE_API_KEY",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("MiniMax Speech 2.8 HD POC driver", () => {
  it("is inert and never implicitly selected when unconfigured", async () => {
    process.env["AI_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-test";
    expect(resolveMinimaxConfig()).toBeNull();
    expect(selectVoiceEngine().name).toBe("openai");
    const result = await minimaxVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "config", engine: "minimax" });
  });

  it("calls t2a_v2 with speech-2.8-hd and returns playable audio without leaking the key", async () => {
    process.env["MINIMAX_API_KEY"] = "mm-secret";
    process.env["MINIMAX_TTS_MODEL"] = "speech-2.8-hd";
    process.env["MINIMAX_TTS_VOICE_ID"] = "Malaysian_Male_1";
    let url = "";
    let body = "";
    globalThis.fetch = vi.fn(async (u: unknown, init: unknown) => {
      url = String(u);
      body = String((init as RequestInit).body);
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await synthesizeSpeech({ text: "Assalamualaikum", provider: "minimax" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.mimeType).toBe("audio/mpeg");
    expect(url).toBe("https://api.minimax.io/v1/t2a_v2");
    expect(body).toContain('"model":"speech-2.8-hd"');
    expect(body).toContain('"voice_id":"Malaysian_Male_1"');
    expect(body).not.toContain("mm-secret");
  });

  it("retries a 429 once and classifies auth failures as terminal", async () => {
    process.env["MINIMAX_API_KEY"] = "mm-secret";
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("rate", { status: 429 });
    }) as unknown as typeof fetch;
    expect(await minimaxVoiceEngine.synthesize({ text: "a" })).toEqual({
      ok: false,
      kind: "rate_limited",
      engine: "minimax",
    });
    expect(calls).toBe(2);

    calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await minimaxVoiceEngine.synthesize({ text: "a" })).toEqual({
      ok: false,
      kind: "unauthorized",
      engine: "minimax",
    });
    expect(calls).toBe(1);
  });

  it("rejects a malformed hex payload as invalid audio", () => {
    expect(hexToBytes("zz").byteLength).toBe(0);
    expect(Array.from(hexToBytes("00ff"))).toEqual([0, 255]);
  });
});
