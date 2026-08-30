import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hexToBytes,
  languageBoostFor,
  minimaxVoiceEngine,
  resolveMinimaxConfig,
} from "@/lib/voice/minimax.server";
import { selectVoiceEngine, synthesizeSpeech } from "@/lib/voice/tts.server";

const realFetch = globalThis.fetch;
const saved = { ...process.env };

beforeEach(() => {
  for (const key of [
    "MINIMAX_TTS_API_KEY",
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
    process.env["MINIMAX_TTS_VOICE_ID"] = "Malay_male_1_v1";
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
    expect(body).toContain('"voice_id":"Malay_male_1_v1"');
    expect(body).toContain('"language_boost":"Malay"');
    expect(body).not.toContain("mm-secret");
  });

  it("defaults to Malay_male_1_v1 with Malay language_boost and speech-2.8-hd", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
    let body = "";
    globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
      body = String((init as RequestInit).body);
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const config = resolveMinimaxConfig();
    expect(config?.model).toBe("speech-2.8-hd");
    expect(config?.voiceId).toBe("Malay_male_1_v1");

    const result = await minimaxVoiceEngine.synthesize({ text: "Assalamualaikum" });
    expect(result.ok).toBe(true);
    expect(body).toContain('"model":"speech-2.8-hd"');
    expect(body).toContain('"voice_id":"Malay_male_1_v1"');
    expect(body).toContain('"language_boost":"Malay"');
    expect(body).toContain('"speed":1');
    expect(body).toContain('"vol":1');
    expect(body).toContain('"pitch":0');
    expect(body).not.toContain("mm-tts-secret");
  });

  it("MINIMAX_TTS_VOICE_ID env override still takes precedence", () => {
    process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
    process.env["MINIMAX_TTS_VOICE_ID"] = "English_Graceful_Lady";
    expect(resolveMinimaxConfig()?.voiceId).toBe("English_Graceful_Lady");
  });

  it("never sends an OpenAI persona voice to MiniMax — falls back to Malay_male_1_v1", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
    let body = "";
    globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
      body = String((init as RequestInit).body);
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await minimaxVoiceEngine.synthesize({ text: "Salam", voice: "coral" });
    expect(result.ok).toBe(true);
    expect(body).toContain('"voice_id":"Malay_male_1_v1"');
    expect(body).not.toContain("coral");
  });

  it("a custom MiniMax voice ID in MINIMAX_TTS_VOICE_ID wins over the persona voice", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
    process.env["MINIMAX_TTS_VOICE_ID"] = "Custom_Designed_Voice_001";
    let body = "";
    globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
      body = String((init as RequestInit).body);
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await minimaxVoiceEngine.synthesize({ text: "Salam", voice: "coral" });
    expect(result.ok).toBe(true);
    expect(body).toContain('"voice_id":"Custom_Designed_Voice_001"');
    expect(body).not.toContain("coral");
  });

  it("an explicit non-OpenAI MiniMax voice argument is honored", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
    let body = "";
    globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
      body = String((init as RequestInit).body);
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await minimaxVoiceEngine.synthesize({
      text: "Salam",
      voice: "Malay_male_1_v1",
    });
    expect(result.ok).toBe(true);
    expect(body).toContain('"voice_id":"Malay_male_1_v1"');
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

  describe("multilingual language_boost routing (voice identity preserved)", () => {
    const cases: Array<[string, string]> = [
      ["ms-MY", "Malay"],
      ["en-US", "English"],
      ["ar-SA", "Arabic"],
      ["zh-CN", "Chinese"],
      ["id-ID", "Indonesian"],
      ["ta-IN", "Tamil"],
      ["ur-PK", "Urdu"],
      ["bn-BD", "Bengali"],
    ];

    it.each(cases)("%s → language_boost=%s with voice_id=Malay_male_1_v1", async (lang, boost) => {
      process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
      let body = "";
      globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
        body = String((init as RequestInit).body);
        return new Response(
          JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await minimaxVoiceEngine.synthesize({ text: "test", language: lang });
      expect(result.ok).toBe(true);
      expect(body).toContain(`"language_boost":"${boost}"`);
      expect(body).toContain('"voice_id":"Malay_male_1_v1"');
      expect(body).toContain('"model":"speech-2.8-hd"');
      expect(body).not.toContain("mm-tts-secret");
    });

    it("missing/unknown/auto language falls back to Malay — never guessed from voice ID", () => {
      expect(languageBoostFor(undefined)).toBe("Malay");
      expect(languageBoostFor(null)).toBe("Malay");
      expect(languageBoostFor("")).toBe("Malay");
      expect(languageBoostFor("auto")).toBe("Malay");
      expect(languageBoostFor("fr-FR")).toBe("Malay");
    });

    it("synthesizeSpeech forwards the conversation language to the engine", async () => {
      process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
      let body = "";
      globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
        body = String((init as RequestInit).body);
        return new Response(
          JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await synthesizeSpeech({
        text: "Hello",
        language: "en-US",
        voice: "coral", // OpenAI persona voice — must NOT reach MiniMax
        provider: "minimax",
      });
      expect(result.ok).toBe(true);
      expect(body).toContain('"language_boost":"English"');
      expect(body).toContain('"voice_id":"Malay_male_1_v1"');
      expect(body).not.toContain("coral");
    });

    it("language_boost changes per language while the MiniMax voice identity stays fixed", () => {
      expect(languageBoostFor("ms-MY")).toBe("Malay");
      expect(languageBoostFor("en-US")).toBe("English");
      expect(languageBoostFor("ar-SA")).toBe("Arabic");
      expect(languageBoostFor("zh-CN")).toBe("Chinese");
      expect(languageBoostFor("id-ID")).toBe("Indonesian");
      expect(languageBoostFor("ta-IN")).toBe("Tamil");
      expect(languageBoostFor("ur-PK")).toBe("Urdu");
      expect(languageBoostFor("bn-BD")).toBe("Bengali");
    });
  });

  it("rejects a malformed hex payload as invalid audio", () => {
    expect(hexToBytes("zz").byteLength).toBe(0);
    expect(Array.from(hexToBytes("00ff"))).toEqual([0, 255]);
  });

  it("classifies insufficient balance (1008) as entitlement, not a credential fault", async () => {
    process.env["MINIMAX_API_KEY"] = "mm-secret";
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    expect(await minimaxVoiceEngine.synthesize({ text: "Assalamualaikum" })).toEqual({
      ok: false,
      kind: "entitlement",
      engine: "minimax",
    });
    // Terminal: a balance state is never retried.
    expect(calls).toBe(1);
  });

  it("classifies an invalid api key (2049) as terminal unauthorized", async () => {
    process.env["MINIMAX_API_KEY"] = "mm-secret";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ base_resp: { status_code: 2049 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    expect(await minimaxVoiceEngine.synthesize({ text: "a" })).toEqual({
      ok: false,
      kind: "unauthorized",
      engine: "minimax",
    });
  });

  it("treats an empty audio payload as invalid audio", async () => {
    process.env["MINIMAX_API_KEY"] = "mm-secret";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { audio: "" }, base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    expect(await minimaxVoiceEngine.synthesize({ text: "a" })).toEqual({
      ok: false,
      kind: "invalid_audio",
      engine: "minimax",
    });
  });

  it("never exposes the key through the non-secret diagnostic", async () => {
    process.env["MINIMAX_API_KEY"] = "mm-secret";
    const { describeMinimax } = await import("@/lib/voice/minimax.server");
    const diagnostic = describeMinimax();
    expect(diagnostic.configured).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain("mm-secret");
  });

  it("prefers MINIMAX_TTS_API_KEY when present and does not expose it", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = "mm-tts-secret";
    process.env["MINIMAX_API_KEY"] = "mm-legacy-secret";
    const { describeMinimax, resolveMinimaxConfig } = await import("@/lib/voice/minimax.server");

    const config = resolveMinimaxConfig();
    expect(config).not.toBeNull();
    expect(config?.apiKey).toBe("mm-tts-secret");

    const diagnostic = describeMinimax();
    expect(diagnostic.configured).toBe(true);
    const json = JSON.stringify(diagnostic);
    expect(json).not.toContain("mm-tts-secret");
    expect(json).not.toContain("mm-legacy-secret");
  });
});
