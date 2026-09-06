/**
 * UMRAIO® — RAIŌ voice-note Opus QUALITY regression.
 *
 * Locks the audited robotic-voice fix: the encoder must run in
 * OPUS_APPLICATION_AUDIO at 48 kbps, complexity 10, fullband — never the
 * VOIP / 24 kbps profile that produced robotic-sounding voice notes.
 * MiniMax provider, model, voice ID, PCM source, OGG/Opus container and
 * native WhatsApp voice-note delivery are all unchanged.
 */
import { describe, expect, it } from "vitest";

import {
  encodePcmToOggOpus,
  OPUS_QUALITY_SETTINGS,
  OPUS_FRAME_SAMPLES,
  PCM_SAMPLE_RATE,
} from "@/lib/voice/opus-encode.server";
import { isOggOpusAudio } from "@/lib/calls/call-audio.core";

function tonePcm(seconds = 0.5): Uint8Array {
  const samples = Math.round(PCM_SAMPLE_RATE * seconds);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / PCM_SAMPLE_RATE)), true);
  }
  return bytes;
}

describe("locked Opus quality settings", () => {
  it("runs AUDIO application, 48 kbps, complexity 10, fullband", () => {
    expect(OPUS_QUALITY_SETTINGS.application).toBe(2049); // OPUS_APPLICATION_AUDIO
    expect(OPUS_QUALITY_SETTINGS.application).not.toBe(2048); // never VOIP again
    expect(OPUS_QUALITY_SETTINGS.bitrate).toBe(48_000);
    expect(OPUS_QUALITY_SETTINGS.complexity).toBe(10);
    expect(OPUS_QUALITY_SETTINGS.bandwidth).toBe(1105); // OPUS_BANDWIDTH_FULLBAND
  });
});

describe("encoded output reflects the quality profile", () => {
  it("produces valid OGG/Opus at materially higher bitrate than the 24 kbps VOIP profile", async () => {
    const seconds = 1;
    const encoded = await encodePcmToOggOpus(tonePcm(seconds));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(isOggOpusAudio("audio/ogg", encoded.bytes)).toBe(true);
    // At 24 kbps, 1 s of audio ≈ 3 000 bytes of payload. The 48 kbps AUDIO
    // profile must land well above that; Ogg page overhead adds a little more.
    expect(encoded.bytes.byteLength).toBeGreaterThan(4_500);
    // Sanity ceiling: still a compact voice note, nowhere near PCM size.
    expect(encoded.bytes.byteLength).toBeLessThan(PCM_SAMPLE_RATE * seconds * 2);
  });

  it("keeps the 24 kHz mono OGG/Opus container contract unchanged", async () => {
    const encoded = await encodePcmToOggOpus(tonePcm(0.4));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const bytes = encoded.bytes;
    const decoder = new TextDecoder();
    expect(decoder.decode(bytes.slice(0, 4))).toBe("OggS");
    expect(decoder.decode(bytes.slice(28, 36))).toBe("OpusHead");
    const head = bytes.slice(28, 28 + 19);
    expect(head[9]).toBe(1); // mono
    expect(new DataView(head.buffer, head.byteOffset).getUint32(12, true)).toBe(24_000);
    // 20 ms frames are preserved.
    expect(OPUS_FRAME_SAMPLES).toBe(480);
  });
});
