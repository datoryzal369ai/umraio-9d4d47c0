/**
 * UMRAIO® — WhatsApp Calling audio container + LOCKED VOICE contract.
 *
 * Proves the voice-turn path only ever emits real OGG/Opus produced by
 * MiniMax, and that NO substitute voice or provider can ever be used.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { isOggOpusAudio } from "@/lib/calls/call-audio.core";
import { synthesizeCallSpeech, requiredCallVoice } from "@/lib/calls/call-audio.server";
import { resolveMinimaxContainer, MINIMAX_DEFAULT_MODEL } from "@/lib/voice/minimax.server";

function oggOpusBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 28); // OpusHead
  return bytes;
}

function mp3Bytes(): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
}

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

describe("synthesizeCallSpeech — locked voice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires MiniMax speech-2.8-hd / Malay_male_1_v1", () => {
    const required = requiredCallVoice();
    expect(required.model).toBe(MINIMAX_DEFAULT_MODEL);
    expect(MINIMAX_DEFAULT_MODEL).toBe("speech-2.8-hd");
    expect(required.voiceId).toBe("Malay_male_1_v1");
  });

  it("returns MiniMax OGG/Opus audio and pins the MiniMax engine only", async () => {
    const synthesize = vi.fn().mockResolvedValue({
      ok: true,
      bytes: oggOpusBytes(),
      mimeType: "audio/ogg",
      engine: "minimax",
    });
    const result = await synthesizeCallSpeech(
      { callId: "c1", text: "Assalamualaikum", voice: "marin", language: "ms-MY" },
      { synthesize: synthesize as never },
    );
    expect(result).toMatchObject({ ok: true, engine: "minimax", fallbackUsed: false });
    expect(synthesize).toHaveBeenCalledTimes(1);
    const request = synthesize.mock.calls[0]![0];
    expect(request.requireOggOpus).toBe(true);
    // A persona voice must never reach the provider.
    expect(request.voice).toBeUndefined();
    expect(request.engine.name).toBe("minimax");
  });

  it("never substitutes another provider's voice, even with valid OGG/Opus", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ ok: true, bytes: oggOpusBytes(), mimeType: "audio/ogg", engine: "openai" });
    const result = await synthesizeCallSpeech(
      { callId: "c2", text: "hai" },
      { synthesize: synthesize as never },
    );
    expect(result).toEqual({ ok: false, reason: "voice_substitution_blocked" });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly — one attempt only — on an unsupported container", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ ok: true, bytes: mp3Bytes(), mimeType: "audio/mpeg", engine: "minimax" });
    const result = await synthesizeCallSpeech(
      { callId: "c3", text: "hai" },
      { synthesize: synthesize as never },
    );
    expect(result).toEqual({ ok: false, reason: "container_audio_mpeg" });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("returns an explicit error — never silent success — when MiniMax fails", async () => {
    const synthesize = vi.fn().mockResolvedValue({ ok: false, kind: "provider", engine: "minimax" });
    const result = await synthesizeCallSpeech(
      { callId: "c4", text: "hai" },
      { synthesize: synthesize as never },
    );
    expect(result).toEqual({ ok: false, reason: "tts_provider" });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});

