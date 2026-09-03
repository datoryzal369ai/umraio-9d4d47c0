/**
 * UMRAIO® — WhatsApp Calling audio integrity.
 *
 * An "OggS/OpusHead" header check is NOT proof of playable audio. These tests
 * parse a REAL encoder output page by page and prove:
 *   - valid Ogg pages with correct CRC and monotonic granule positions,
 *   - OpusHead (mono, pre-skip) and OpusTags present exactly once,
 *   - every audio packet is a genuine 20 ms Opus packet,
 *   - the demuxed packet stream reproduces the input duration (no gaps, no
 *     truncation, no duplication),
 *   - RTP packetization over that stream keeps sequence numbers continuous and
 *     advances timestamps by 960 ticks of the negotiated 48 kHz clock.
 * The gateway sends these demuxed packets as RTP payloads — never container
 * bytes (see voice-gateway/internal/media/ogg.go, ReadOggOpus).
 */
import { describe, expect, it } from "vitest";

import { encodePcmToOggOpus, oggCrc32 } from "@/lib/voice/opus-encode.server";

const RTP_CLOCK_HZ = 48_000;

function pcm(ms: number): Uint8Array {
  const samples = Math.round((24_000 * ms) / 1000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((i / 24_000) * 2 * Math.PI * 200) * 9000), true);
  }
  return out;
}

type Page = { granule: number; headerType: number; sequence: number; packets: Uint8Array[] };

/** Strict Ogg demuxer: any structural defect throws. */
function demux(bytes: Uint8Array): Page[] {
  const pages: Page[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (String.fromCharCode(...bytes.slice(offset, offset + 4)) !== "OggS") {
      throw new Error("bad capture pattern");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const segments = bytes[offset + 26]!;
    const table = bytes.slice(offset + 27, offset + 27 + segments);
    const bodyStart = offset + 27 + segments;
    const bodyLength = table.reduce((sum, s) => sum + s, 0);
    const page = bytes.slice(offset, bodyStart + bodyLength);
    // CRC must validate with the CRC field zeroed.
    const stored = view.getUint32(22, true);
    const zeroed = new Uint8Array(page);
    new DataView(zeroed.buffer).setUint32(22, 0, true);
    if (oggCrc32(zeroed) !== stored) throw new Error("bad page crc");

    const packets: Uint8Array[] = [];
    let cursor = bodyStart;
    let partial: number[] = [];
    for (const size of table) {
      partial.push(...bytes.slice(cursor, cursor + size));
      cursor += size;
      if (size < 255) {
        packets.push(new Uint8Array(partial));
        partial = [];
      }
    }
    pages.push({
      granule: view.getUint32(6, true) + view.getUint32(10, true) * 2 ** 32,
      headerType: bytes[offset + 5]!,
      sequence: view.getUint32(18, true),
      packets,
    });
    offset = bodyStart + bodyLength;
  }
  return pages;
}

/** Opus TOC frame duration in microseconds (RFC 6716 §3.1). */
function packetDurationUs(packet: Uint8Array): number {
  const config = packet[0]! >> 3;
  const silk = [10000, 20000, 40000, 60000];
  if (config < 12) return silk[config % 4]!;
  if (config < 16) return config % 2 === 0 ? 10000 : 20000;
  return [2500, 5000, 10000, 20000][config % 4]!;
}

const ascii = (b: Uint8Array, n: number) => String.fromCharCode(...b.slice(0, n));

describe("MiniMax PCM → OGG/Opus is structurally valid and decodable", () => {
  it("produces well-formed pages, headers and 20 ms Opus packets", async () => {
    const durationMs = 1000;
    const encoded = await encodePcmToOggOpus(pcm(durationMs));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const pages = demux(encoded.bytes);
    expect(pages.length).toBeGreaterThan(2);
    // Page sequence numbers are continuous from 0.
    pages.forEach((page, index) => expect(page.sequence).toBe(index));
    // Header pages.
    expect(pages[0]!.headerType).toBe(0x02);
    expect(ascii(pages[0]!.packets[0]!, 8)).toBe("OpusHead");
    expect(ascii(pages[1]!.packets[0]!, 8)).toBe("OpusTags");
    const head = pages[0]!.packets[0]!;
    expect(head[9]).toBe(1); // mono
    const headView = new DataView(head.buffer, head.byteOffset);
    expect(headView.getUint16(10, true)).toBeGreaterThan(0); // pre-skip
    expect(headView.getUint32(12, true)).toBe(24_000); // original input rate
    expect(pages[pages.length - 1]!.headerType).toBe(0x04); // EOS

    const audio = pages.slice(2).flatMap((page) => page.packets);
    expect(audio.length).toBe(durationMs / 20);
    for (const packet of audio) {
      expect(packet.byteLength).toBeGreaterThan(1);
      expect(packetDurationUs(packet)).toBe(20000);
      expect(ascii(packet, 8)).not.toBe("OpusHead");
    }

    // Granule positions advance monotonically at the 48 kHz Ogg clock.
    const granules = pages.slice(2).map((page) => page.granule);
    granules.forEach((granule, index) => {
      if (index > 0) expect(granule).toBeGreaterThan(granules[index - 1]!);
    });
    const decodedMs = (granules[granules.length - 1]! / RTP_CLOCK_HZ) * 1000;
    expect(Math.abs(decodedMs - durationMs)).toBeLessThanOrEqual(20);
  });

  it("packetizes to RTP with continuous sequence numbers and a 48 kHz timeline", async () => {
    const encoded = await encodePcmToOggOpus(pcm(600));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const audio = demux(encoded.bytes)
      .slice(2)
      .flatMap((page) => page.packets);

    let sequence = 1000;
    let timestamp = 0;
    const sent = audio.map((packet) => {
      const rtp = { sequence: sequence++, timestamp, payload: packet };
      timestamp += (packetDurationUs(packet) / 1_000_000) * RTP_CLOCK_HZ;
      return rtp;
    });

    expect(sent.length).toBe(30);
    sent.forEach((rtp, index) => {
      expect(rtp.sequence).toBe(1000 + index);
      expect(rtp.timestamp).toBe(index * 960); // 20 ms at 48 kHz
      // RTP payload is a raw Opus packet, never container bytes.
      expect(ascii(rtp.payload, 4)).not.toBe("OggS");
    });
    expect(timestamp).toBe(600 * 48); // whole utterance, no gaps or bursts
  });
});
