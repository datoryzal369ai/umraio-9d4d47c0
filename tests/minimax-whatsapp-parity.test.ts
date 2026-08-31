/**
 * UMRAIO® — MiniMax WhatsApp voice parity.
 *
 * Proves the real WhatsApp MiniMax request matches the validated Voice Test
 * request (speed 1.0, Malay_male_1_v1, speech-2.8-hd, dynamic language_boost)
 * and that the outbound Meta upload declares MP3 metadata truthfully.
 * OpenAI Direct behaviour must remain untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { minimaxVoiceEngine, MINIMAX_FIXED_SPEED } from "@/lib/voice/minimax.server";
import { openAiVoiceEngine } from "@/lib/voice/tts.server";
import {
  sendWhatsappAudio,
  supportsNativeVoiceNote,
  whatsappAudioFilename,
} from "@/lib/whatsapp-send.server";

const realFetch = globalThis.fetch;
const saved = { ...process.env };

const API_KEY = "minimax-test-key-do-not-log";

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

async function captureMinimaxBody(
  input: { text: string; voice?: string; speed?: number; language?: string },
): Promise<Record<string, any>> {
  process.env["MINIMAX_TTS_API_KEY"] = API_KEY;
  let body: Record<string, any> = {};
  globalThis.fetch = vi.fn(async (_url: any, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ data: { audio: hex([0xff, 0xfb, 0x10, 0x00]) }, base_resp: { status_code: 0 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const result = await minimaxVoiceEngine.synthesize(input);
  expect(result.ok).toBe(true);
  return body;
}

describe("MiniMax WhatsApp speed parity", () => {
  it("always sends speed 1.0", async () => {
    const body = await captureMinimaxBody({ text: "Assalamualaikum." });
    expect(MINIMAX_FIXED_SPEED).toBe(1);
    expect(body["voice_setting"].speed).toBe(1);
  });

  it("ignores the OpenAI persona pace value from the WhatsApp path", async () => {
    for (const speed of [0.86, 0.97, 1.06]) {
      const body = await captureMinimaxBody({ text: "Pakej Umrah.", speed });
      expect(body["voice_setting"].speed).toBe(1);
    }
  });
});

describe("MiniMax identity and language routing are unchanged", () => {
  it("keeps voice_id Malay_male_1_v1 even when a persona voice is passed", async () => {
    const body = await captureMinimaxBody({ text: "Baik.", voice: "marin", speed: 0.97 });
    expect(body["voice_setting"].voice_id).toBe("Malay_male_1_v1");
  });

  it("keeps model speech-2.8-hd", async () => {
    const body = await captureMinimaxBody({ text: "Baik." });
    expect(body["model"]).toBe("speech-2.8-hd");
  });

  it("keeps dynamic language_boost mapping", async () => {
    const cases: Array<[string | undefined, string]> = [
      ["ms-MY", "Malay"],
      ["en-US", "English"],
      ["ar-SA", "Arabic"],
      ["zh-CN", "Chinese"],
      ["id-ID", "Indonesian"],
      ["ta-IN", "Tamil"],
      ["ur-PK", "Urdu"],
      ["bn-BD", "Bengali"],
      [undefined, "Malay"],
      ["klingon", "Malay"],
    ];
    for (const [language, expected] of cases) {
      const body = await captureMinimaxBody({
        text: "Baik.",
        ...(language ? { language } : {}),
      });
      expect(body["language_boost"]).toBe(expected);
    }
  });

  it("never leaks the API key into the request body", async () => {
    const body = await captureMinimaxBody({ text: "Baik." });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("never logs the API key", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    await captureMinimaxBody({ text: "Baik." });
    expect(logs.join("\n")).not.toContain(API_KEY);
  });
});

describe("OpenAI Direct TTS remains unchanged", () => {
  it("still forwards persona speed and opus output", async () => {
    process.env["AI_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-test";
    let body: Record<string, any> = {};
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(String(init.body));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await openAiVoiceEngine.synthesize({
      text: "Baik.",
      voice: "marin",
      speed: 0.97,
      instructions: "warm",
    });
    expect(result.ok).toBe(true);
    expect(body["speed"]).toBe(0.97);
    expect(body["voice"]).toBe("marin");
    expect(body["response_format"]).toBe("opus");
    if (result.ok) expect(result.mimeType).toBe("audio/ogg");
  });
});

describe("WhatsApp outbound audio metadata", () => {
  it("maps MIME to a truthful filename", () => {
    expect(whatsappAudioFilename("audio/mpeg")).toBe("reply.mp3");
    expect(whatsappAudioFilename("audio/ogg")).toBe("reply.ogg");
    expect(whatsappAudioFilename("audio/ogg; codecs=opus")).toBe("reply.ogg");
  });

  it("only OGG/Opus supports a native voice note", () => {
    expect(supportsNativeVoiceNote("audio/ogg")).toBe(true);
    expect(supportsNativeVoiceNote("audio/mpeg")).toBe(false);
  });

  it("uploads MiniMax MP3 as reply.mp3 / audio/mpeg without the voice flag", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/media")) {
        return new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await sendWhatsappAudio("pnid", "token", "60123456789", {
      bytes: new Uint8Array([0xff, 0xfb, 0x10, 0x00]),
      mimeType: "audio/mpeg",
    });
    expect(ok).toBe(true);

    const upload = calls[0]!.init.body as FormData;
    expect(upload.get("type")).toBe("audio/mpeg");
    expect((upload.get("file") as File).name).toBe("reply.mp3");

    const send = JSON.parse(String(calls[1]!.init.body));
    expect(send.type).toBe("audio");
    expect(send.audio.voice).toBeUndefined();
  });

  it("marks OGG/Opus audio as a native voice note", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/media")) {
        return new Response(JSON.stringify({ id: "media-2" }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.2" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await sendWhatsappAudio("pnid", "token", "60123456789", {
      bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
      mimeType: "audio/ogg",
    });
    const upload = calls[0]!.init.body as FormData;
    expect((upload.get("file") as File).name).toBe("reply.ogg");
    const send = JSON.parse(String(calls[1]!.init.body));
    expect(send.audio.voice).toBe(true);
  });
});
