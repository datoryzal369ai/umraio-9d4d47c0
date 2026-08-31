/**
 * MiniMax PCM → OGG/Opus native WhatsApp voice note.
 *
 * Covers: PCM request parameters, encoder output structure (OggS/OpusHead/
 * OpusTags/CRC/sequence/granule), MIME + WhatsApp metadata, the MP3 fallback,
 * secret hygiene and the untouched voice/model/language contracts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildOpusHead,
  buildOpusTags,
  encodePcmToOggOpus,
  muxOggOpus,
  oggCrc32,
  OPUS_FRAME_SAMPLES,
  PCM_CHANNELS,
  PCM_SAMPLE_RATE,
} from "@/lib/voice/opus-encode.server";
import {
  languageBoostFor,
  minimaxVoiceEngine,
  resolveMinimaxContainer,
} from "@/lib/voice/minimax.server";
import { supportsNativeVoiceNote, whatsappAudioFilename } from "@/lib/whatsapp-send.server";

const realFetch = globalThis.fetch;
const saved = { ...process.env };

const SECRET = "mm-tts-secret";

/** 24 kHz mono s16le speech-like tone, ~0.5 s. */
function tonePcm(seconds = 0.5): Uint8Array {
  const samples = Math.round(PCM_SAMPLE_RATE * seconds);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / PCM_SAMPLE_RATE)), true);
  }
  return bytes;
}

function mockMinimax(onBody: (body: string) => void, audioHex: () => string) {
  globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
    onBody(String((init as RequestInit).body));
    return new Response(
      JSON.stringify({ data: { audio: audioHex() }, base_resp: { status_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => {
  for (const key of [
    "MINIMAX_TTS_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_TTS_MODEL",
    "MINIMAX_TTS_VOICE_ID",
    "MINIMAX_TTS_CONTAINER",
    "MINIMAX_GROUP_ID",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("feature flag", () => {
  it("defaults to mp3 and only opts in on the exact value", () => {
    expect(resolveMinimaxContainer()).toBe("mp3");
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg";
    expect(resolveMinimaxContainer()).toBe("mp3");
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    expect(resolveMinimaxContainer()).toBe("ogg_opus");
  });

  it("mp3 remains the production path and is unchanged", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = SECRET;
    let body = "";
    mockMinimax((b) => (body = b), () => "494433");
    const result = await minimaxVoiceEngine.synthesize({ text: "Salam" });
    expect(result.ok && result.mimeType).toBe("audio/mpeg");
    expect(body).toContain('"format":"mp3"');
    expect(body).toContain('"voice_id":"Malay_male_1_v1"');
    expect(body).not.toContain(SECRET);
  });
});

describe("PCM request parameters", () => {
  it("requests s16le 24 kHz mono PCM while preserving voice, model and language", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = SECRET;
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    const bodies: string[] = [];
    mockMinimax((b) => bodies.push(b), () => toHex(tonePcm(0.2)));

    const result = await minimaxVoiceEngine.synthesize({ text: "Assalamualaikum", language: "ms-MY" });
    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(1); // no MP3 retry when encoding succeeds
    const body = bodies[0]!;
    expect(body).toContain('"format":"pcm"');
    expect(body).toContain('"sample_rate":24000');
    expect(body).toContain('"channel":1');
    expect(body).toContain('"model":"speech-2.8-hd"');
    expect(body).toContain('"voice_id":"Malay_male_1_v1"');
    expect(body).toContain('"language_boost":"Malay"');
    expect(body).toContain('"speed":1');
    expect(body).toContain('"vol":1');
    expect(body).toContain('"pitch":0');
    expect(body).not.toContain(SECRET);
  });

  it("returns audio/ogg with a complete OGG/Opus payload", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = SECRET;
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    mockMinimax(() => {}, () => toHex(tonePcm(0.3)));
    const result = await minimaxVoiceEngine.synthesize({ text: "Salam" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe("audio/ogg");
    expect(new TextDecoder().decode(result.bytes.slice(0, 4))).toBe("OggS");
    expect(result.bytes.byteLength).toBeGreaterThan(100);
  });

  it("all 8 language mappings remain intact", () => {
    expect(languageBoostFor("ms-MY")).toBe("Malay");
    expect(languageBoostFor("en-US")).toBe("English");
    expect(languageBoostFor("ar-SA")).toBe("Arabic");
    expect(languageBoostFor("zh-CN")).toBe("Chinese");
    expect(languageBoostFor("id-ID")).toBe("Indonesian");
    expect(languageBoostFor("ta-IN")).toBe("Tamil");
    expect(languageBoostFor("ur-PK")).toBe("Urdu");
    expect(languageBoostFor("bn-BD")).toBe("Bengali");
    expect(languageBoostFor("fr-FR")).toBe("Malay");
  });
});

describe("OGG/Opus structure", () => {
  it("produces valid pages: magic, headers, CRC, sequence and granule", async () => {
    const encoded = await encodePcmToOggOpus(tonePcm(0.5));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const bytes = encoded.bytes;
    const decoder = new TextDecoder();

    type Page = { seq: number; granule: number; payload: Uint8Array; type: number };
    const pages: Page[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      expect(decoder.decode(bytes.slice(offset, offset + 4))).toBe("OggS");
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
      expect(bytes[offset + 4]).toBe(0); // stream structure version
      const segments = bytes[offset + 26]!;
      const table = bytes.slice(offset + 27, offset + 27 + segments);
      const payloadLength = table.reduce((sum, n) => sum + n, 0);
      const headerLength = 27 + segments;
      const page = bytes.slice(offset, offset + headerLength + payloadLength);

      // CRC must validate over the page with the CRC field zeroed.
      const stored = view.getUint32(22, true);
      const check = page.slice();
      new DataView(check.buffer).setUint32(22, 0, true);
      expect(oggCrc32(check)).toBe(stored);

      pages.push({
        seq: view.getUint32(18, true),
        granule: view.getUint32(6, true) + view.getUint32(10, true) * 2 ** 32,
        payload: page.slice(headerLength),
        type: bytes[offset + 5]!,
      });
      offset += page.length;
    }

    expect(pages.length).toBeGreaterThan(3);
    // Sequence numbers are contiguous from zero.
    pages.forEach((page, index) => expect(page.seq).toBe(index));
    // First page = BOS, last page = EOS.
    expect(pages[0]!.type).toBe(0x02);
    expect(pages[pages.length - 1]!.type).toBe(0x04);
    // Header packets.
    expect(decoder.decode(pages[0]!.payload.slice(0, 8))).toBe("OpusHead");
    expect(decoder.decode(pages[1]!.payload.slice(0, 8))).toBe("OpusTags");
    expect(pages[0]!.granule).toBe(0);
    expect(pages[1]!.granule).toBe(0);
    // Granule positions advance by one 20 ms frame at the 48 kHz Ogg clock.
    const preSkip = new DataView(
      pages[0]!.payload.buffer,
      pages[0]!.payload.byteOffset,
    ).getUint16(10, true);
    expect(pages[0]!.payload[9]).toBe(PCM_CHANNELS);
    expect(
      new DataView(pages[0]!.payload.buffer, pages[0]!.payload.byteOffset).getUint32(12, true),
    ).toBe(PCM_SAMPLE_RATE);
    for (let i = 2; i < pages.length; i++) {
      expect(pages[i]!.granule).toBe(preSkip + (i - 1) * OPUS_FRAME_SAMPLES * 2);
      expect(pages[i]!.payload.byteLength).toBeGreaterThan(0);
    }
    // Total duration matches 0.5 s of audio (25 frames of 20 ms).
    expect(pages.length - 2).toBe(25);
  });

  it("OpusHead / OpusTags are well formed", () => {
    const head = buildOpusHead(1, 312, 24000);
    expect(head.byteLength).toBe(19);
    expect(head[8]).toBe(1);
    expect(head[9]).toBe(1);
    expect(head[18]).toBe(0);
    const tags = buildOpusTags();
    expect(new TextDecoder().decode(tags.slice(0, 8))).toBe("OpusTags");
    expect(new DataView(tags.buffer).getUint32(tags.byteLength - 4, true)).toBe(0);
  });

  it("Ogg CRC32 matches the reference polynomial", () => {
    // Known vector: CRC of "OggS" under the Ogg (non-reflected) CRC-32.
    expect(oggCrc32(new TextEncoder().encode("OggS"))).toBe(1605413199);
    expect(oggCrc32(new Uint8Array(0))).toBe(0);
  });

  it("rejects empty or unusable PCM without throwing", async () => {
    expect(await encodePcmToOggOpus(new Uint8Array(0))).toEqual({
      ok: false,
      reason: "invalid_pcm",
    });
  });

  it("mux refuses an oversized single packet instead of writing a corrupt page", () => {
    expect(() =>
      muxOggOpus([{ data: new Uint8Array(255 * 256), granule: 0 }], 1),
    ).toThrow();
  });
});

describe("WhatsApp delivery metadata", () => {
  it("OGG is a native voice note; MP3 stays an attachment", () => {
    expect(whatsappAudioFilename("audio/ogg")).toBe("reply.ogg");
    expect(supportsNativeVoiceNote("audio/ogg")).toBe(true);
    expect(whatsappAudioFilename("audio/mpeg")).toBe("reply.mp3");
    expect(supportsNativeVoiceNote("audio/mpeg")).toBe(false);
  });
});

describe("fallback", () => {
  it("falls back to exactly one MP3 request when encoding fails", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = SECRET;
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    const bodies: string[] = [];
    // A 1-byte "PCM" response: accepted by the API layer, unusable by the encoder.
    mockMinimax(
      (b) => bodies.push(b),
      () => (bodies.length === 1 ? "00" : "494433"),
    );

    const result = await minimaxVoiceEngine.synthesize({ text: "Salam" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.mimeType).toBe("audio/mpeg");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('"format":"pcm"');
    expect(bodies[1]).toContain('"format":"mp3"');
    expect(bodies.join("")).not.toContain(SECRET);
  });

  it("falls back to MP3 when the PCM request itself fails", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = SECRET;
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    let call = 0;
    globalThis.fetch = vi.fn(async (_u: unknown, init: unknown) => {
      call += 1;
      const body = String((init as RequestInit).body);
      if (body.includes('"format":"pcm"')) return new Response("bad", { status: 400 });
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await minimaxVoiceEngine.synthesize({ text: "Salam" });
    expect(result.ok && result.mimeType).toBe("audio/mpeg");
    expect(call).toBe(2);
  });

  it("surfaces a terminal failure when MP3 also fails", async () => {
    process.env["MINIMAX_TTS_API_KEY"] = SECRET;
    process.env["MINIMAX_TTS_CONTAINER"] = "ogg_opus";
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    expect(await minimaxVoiceEngine.synthesize({ text: "Salam" })).toEqual({
      ok: false,
      kind: "unauthorized",
      engine: "minimax",
    });
  });
});
