/**
 * UMRAIO® — WhatsApp Calling audio container repair.
 *
 * Proves the voice-turn path only ever emits real OGG/Opus, falls back to
 * OpenAI exactly once for an unsupported container, and never returns silent
 * success when both providers fail.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { isOggOpusAudio } from "@/lib/calls/call-audio.core";
import { synthesizeCallSpeech } from "@/lib/calls/call-audio.server";
import { resolveMinimaxContainer } from "@/lib/voice/minimax.server";
import type { VoiceEngine } from "@/lib/voice/tts.server";

function oggOpusBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 28); // OpusHead
  return bytes;
}

function mp3Bytes(): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
}

const fallbackEngine = { name: "openai", synthesize: vi.fn() } as unknown as VoiceEngine;

describe("call audio container validation", () => {
  it("accepts only OGG with an Opus stream", () => {
    expect(isOggOpusAudio("audio/ogg", oggOpusBytes())).toBe(true);
    expect(isOggOpusAudio("audio/mpeg", mp3Bytes())).toBe(false);
    expect(isOggOpusAudio("audio/ogg", mp3Bytes())).toBe(false);
    expect(isOggOpusAudio("audio/ogg", new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe(false);
  });
});

describe("MINIMAX_TTS_CONTAINER production value", () => {
  const previous = process.env["MINIMAX_TTS_CONTAINER"];
  afterEach(() => {
    if (previous === undefined) delete process.env["MINIMAX_TTS_CONTAINER"];
    else process.env["MINIMAX_TTS_CONTAINER"] = previous;
  });

  it("selects the OGG/Opus MiniMax path when configured", () => {
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    expect(resolveMinimaxContainer()).toBe("ogg_opus");
  });
});

describe("synthesizeCallSpeech", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns MiniMax OGG/Opus audio without a fallback", async () => {
    const synthesize = vi.fn().mockResolvedValue({
      ok: true,
      bytes: oggOpusBytes(),
      mimeType: "audio/ogg",
      engine: "minimax",
    });
    const result = await synthesizeCallSpeech(
      { callId: "c1", text: "Assalamualaikum" },
      { synthesize: synthesize as never, fallbackEngine },
    );
    expect(result).toMatchObject({ ok: true, engine: "minimax", fallbackUsed: false });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("falls back to OpenAI exactly once on an unsupported container", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, bytes: mp3Bytes(), mimeType: "audio/mpeg", engine: "minimax" })
      .mockResolvedValueOnce({ ok: true, bytes: oggOpusBytes(), mimeType: "audio/ogg", engine: "openai" });

    const result = await synthesizeCallSpeech(
      { callId: "c2", text: "hai" },
      { synthesize: synthesize as never, fallbackEngine },
    );
    expect(result).toMatchObject({ ok: true, engine: "openai", fallbackUsed: true });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize.mock.calls[1]![0].engine).toBe(fallbackEngine);
  });

  it("falls back when MiniMax returns invalid OGG/Opus bytes", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, bytes: mp3Bytes(), mimeType: "audio/ogg", engine: "minimax" })
      .mockResolvedValueOnce({ ok: true, bytes: oggOpusBytes(), mimeType: "audio/ogg", engine: "openai" });

    const result = await synthesizeCallSpeech(
      { callId: "c3", text: "hai" },
      { synthesize: synthesize as never, fallbackEngine },
    );
    expect(result).toMatchObject({ ok: true, fallbackUsed: true });
  });

  it("returns an explicit error — never silent success — when both providers fail", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: "provider", engine: "minimax" })
      .mockResolvedValueOnce({ ok: false, kind: "timeout", engine: "openai" });

    const result = await synthesizeCallSpeech(
      { callId: "c4", text: "hai" },
      { synthesize: synthesize as never, fallbackEngine },
    );
    expect(result).toEqual({ ok: false, reason: "tts_timeout" });
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it("does not attempt a third provider when the fallback container is still unsupported", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ ok: true, bytes: mp3Bytes(), mimeType: "audio/mpeg", engine: "minimax" });

    const result = await synthesizeCallSpeech(
      { callId: "c5", text: "hai" },
      { synthesize: synthesize as never, fallbackEngine },
    );
    expect(result).toEqual({ ok: false, reason: "tts_container_unsupported" });
    expect(synthesize).toHaveBeenCalledTimes(2);
  });
});
