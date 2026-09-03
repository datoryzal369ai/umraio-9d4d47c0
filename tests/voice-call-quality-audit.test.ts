/**
 * UMRAIO® — WhatsApp Calling voice quality repair.
 *
 * Evidence (live call ms_317c3396926af52a1f46a5aa): MiniMax returned
 * audio/mpeg because the in-process Opus encoder reported `wasm_unavailable`,
 * so every greeting and reply came from the OpenAI fallback — robotic and
 * non-Malaysian. These tests lock the repaired behaviour:
 *   - the call path always requests OGG/Opus from MiniMax,
 *   - it never wastes a second MP3 round trip it cannot transmit,
 *   - Malay_male_1_v1 / ms-MY stay the effective identity,
 *   - the OpenAI fallback still exists but is explicit, never silent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { minimaxVoiceEngine, MINIMAX_DEFAULT_VOICE_ID } from "@/lib/voice/minimax.server";
import { encodePcmToOggOpus } from "@/lib/voice/opus-encode.server";
import { isOggOpusAudio } from "@/lib/calls/call-audio.core";
import { synthesizeCallSpeech } from "@/lib/calls/call-audio.server";
import { resolveVoiceLanguage, languageInstruction } from "@/lib/voice/language.core";

const realFetch = globalThis.fetch;
const saved = { ...process.env };

function pcmTone(ms = 200): Uint8Array {
  const samples = Math.round((24000 * ms) / 1000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((i / 24000) * 2 * Math.PI * 220) * 8000), true);
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => {
  process.env["MINIMAX_TTS_API_KEY"] = "minimax-test-key";
  delete process.env["MINIMAX_TTS_VOICE_ID"];
  delete process.env["MINIMAX_TTS_CONTAINER"];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("Opus encoder is available to the call path", () => {
  it("encodes MiniMax PCM into valid, non-trivial OGG/Opus", async () => {
    const encoded = await encodePcmToOggOpus(pcmTone());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(isOggOpusAudio("audio/ogg", encoded.bytes)).toBe(true);
    expect(encoded.bytes.byteLength).toBeGreaterThan(200);
  });
});

describe("Voice and language lock", () => {
  it("uses Malay_male_1_v1 and ms-MY even when a persona voice is supplied", async () => {
    let body: Record<string, any> = {};
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ data: { audio: hex(pcmTone()) }, base_resp: { status_code: 0 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await minimaxVoiceEngine.synthesize({
      text: "Assalamualaikum.",
      voice: "marin",
      language: "ms-MY",
      requireOggOpus: true,
    });

    expect(body["voice_setting"].voice_id).toBe(MINIMAX_DEFAULT_VOICE_ID);
    expect(body["language_boost"]).toBe("Malay");
    expect(body["audio_setting"].format).toBe("pcm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mimeType).toBe("audio/ogg");
  });

  it("resolves an unknown call language to ms-MY and forbids Indonesian delivery", () => {
    expect(resolveVoiceLanguage(undefined)).toBe("ms-MY");
    expect(resolveVoiceLanguage("")).toBe("ms-MY");
    const text = languageInstruction("ms-MY").toLowerCase();
    expect(text).toContain("malaysian malay");
    expect(text).toContain("do not speak bahasa indonesia");
  });
});

describe("Latency: no unusable MP3 round trip on a live call", () => {
  it("fails fast instead of requesting MP3 when Opus encoding is impossible", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      calls.push(JSON.parse(String(init.body)).audio_setting.format);
      // Non-PCM garbage: the encoder cannot produce usable Opus from 1 byte.
      return new Response(
        JSON.stringify({ data: { audio: "00" }, base_resp: { status_code: 0 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await minimaxVoiceEngine.synthesize({
      text: "Baik.",
      language: "ms-MY",
      requireOggOpus: true,
    });

    expect(calls).toEqual(["pcm"]);
    expect(result.ok).toBe(false);
  });

  it("the WhatsApp message path still keeps its MP3 safety net", async () => {
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      calls.push(JSON.parse(String(init.body)).audio_setting.format);
      return new Response(
        JSON.stringify({ data: { audio: "00" }, base_resp: { status_code: 0 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await minimaxVoiceEngine.synthesize({ text: "Baik.", language: "ms-MY" });
    expect(calls).toEqual(["pcm", "mp3"]);
  });
});

describe("Call speech contract", () => {
  it("requests OGG/Opus explicitly for every call turn", async () => {
    const synthesize = vi.fn(async (input: any) => {
      expect(input.requireOggOpus).toBe(true);
      const encoded = await encodePcmToOggOpus(pcmTone());
      if (!encoded.ok) throw new Error("encoder unavailable");
      return { ok: true, bytes: encoded.bytes, mimeType: "audio/ogg", engine: "minimax" };
    });
    const result = await synthesizeCallSpeech(
      { text: "Assalamualaikum.", language: "ms-MY", callId: "c1" },
      { synthesize: synthesize as any },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.engine).toBe("minimax");
      expect(result.fallbackUsed).toBe(false);
    }
  });

  it("never returns silent success when both providers fail", async () => {
    const synthesize = vi.fn(async () => ({ ok: false, kind: "provider", engine: "minimax" }));
    const result = await synthesizeCallSpeech(
      { text: "Baik.", language: "ms-MY", callId: "c2" },
      { synthesize: synthesize as any, fallbackEngine: { name: "openai", synthesize: async () => ({ ok: false, kind: "provider", engine: "openai" }) } as any },
    );
    expect(result.ok).toBe(false);
  });
});
