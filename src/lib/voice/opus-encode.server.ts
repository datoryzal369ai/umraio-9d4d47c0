/**
 * UMRAIO® VOICE — raw PCM → OGG/Opus encoder (server-only, Worker-safe).
 *
 * WHY: Meta renders a NATIVE WhatsApp voice note only for OGG/Opus. MiniMax
 * returns MP3 (attachment bubble) or raw PCM. This module turns the validated
 * MiniMax PCM (s16le / 24 kHz / mono) into a complete, playable OGG/Opus file
 * with no resampling, no FFmpeg, no child_process and no remote fetch.
 *
 * RUNTIME: libopus ships as a bundled Wasm module (./opus/opus.wasm), which is
 * what Cloudflare Workers require — they refuse runtime compilation. The base64
 * copy is the fallback for Node/vitest. Nothing is fetched or read from disk.
 *
 * FAILURE CONTRACT: this module NEVER throws to callers. Every failure returns
 * `{ ok: false }` so the voice reply can fall back to the existing MP3 path.
 */

import { OPUS_WASM_BASE64 } from "./opus/opus-wasm.base64";
// Bundled Wasm module: Cloudflare compiles this at deploy time (workerd forbids
// runtime WebAssembly.compile). The binary is import-free (WASI/emscripten stubs
// merged in) so the bundler has nothing to resolve.
import bundledOpusModule from "./opus/opus.wasm";

/** Opus operates on 20 ms frames; at 24 kHz that is exactly 480 samples. */
export const OPUS_FRAME_SAMPLES = 480;
export const PCM_SAMPLE_RATE = 24_000;
export const PCM_CHANNELS = 1;
/** Ogg granule positions are ALWAYS expressed at 48 kHz, whatever the input rate. */
const GRANULE_RATE = 48_000;
const GRANULE_SCALE = GRANULE_RATE / PCM_SAMPLE_RATE;
/** OPUS_GET_LOOKAHEAD_REQUEST */
const OPUS_GET_LOOKAHEAD = 4027;
/** OPUS_SET_BITRATE_REQUEST — 24 kbps mono voice is ample for speech. */
const OPUS_SET_BITRATE = 4002;
const OPUS_APPLICATION_VOIP = 2048;
const OPUS_TARGET_BITRATE = 24_000;

export type OpusEncodeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "wasm_unavailable" | "invalid_pcm" | "encode_failed" | "mux_failed" };

type OpusExports = {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  opus_encoder_get_size(channels: number): number;
  opus_encoder_init(ptr: number, rate: number, channels: number, application: number): number;
  opus_encoder_ctl_set(ptr: number, request: number, value: number): number;
  opus_encoder_ctl_get(ptr: number, request: number): number;
  opus_encode(
    ptr: number,
    pcm: number,
    frameSize: number,
    out: number,
    maxBytes: number,
  ): number;
};

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

let modulePromise: Promise<WebAssembly.Module | null> | null = null;

async function loadOpusModule(): Promise<WebAssembly.Module | null> {
  // The binary is embedded in the bundle as base64 — never fetched, never read
  // from disk. Compilation is attempted once and cached for the isolate.
  const bundled = bundledOpusModule as unknown;
  if (bundled instanceof WebAssembly.Module) return bundled;
  try {
    return await WebAssembly.compile(base64ToBytes(OPUS_WASM_BASE64));
  } catch {
    return null;
  }
}

function opusModule(): Promise<WebAssembly.Module | null> {
  if (!modulePromise) modulePromise = loadOpusModule();
  return modulePromise;
}

/** Ogg CRC32: polynomial 0x04c11db7, no reflection, zero init, zero final xor. */
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

type OggPacket = { data: Uint8Array; granule: number };

/**
 * Minimal, spec-correct Ogg muxer. One packet per page keeps segment tables
 * trivial and is what every reference Opus-in-Ogg voice file looks like for
 * short speech; each page carries the running granule position at 48 kHz.
 */
export function muxOggOpus(packets: OggPacket[], serial: number): Uint8Array {
  const pages: Uint8Array[] = [];
  let sequence = 0;

  const writePage = (payload: Uint8Array, granule: number, headerType: number) => {
    const laced: number[] = [];
    let remaining = payload.length;
    while (remaining >= 255) {
      laced.push(255);
      remaining -= 255;
    }
    laced.push(remaining);
    if (laced.length > 255) throw new Error("packet too large for a single page");

    const page = new Uint8Array(27 + laced.length + payload.length);
    const view = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0; // stream structure version
    page[5] = headerType;
    // Granule position: 64-bit little endian.
    view.setUint32(6, granule >>> 0, true);
    view.setUint32(10, Math.floor(granule / 2 ** 32), true);
    view.setUint32(14, serial >>> 0, true);
    view.setUint32(18, sequence >>> 0, true);
    view.setUint32(22, 0, true); // CRC placeholder
    page[26] = laced.length;
    page.set(laced, 27);
    page.set(payload, 27 + laced.length);
    view.setUint32(22, oggCrc32(page), true);
    sequence += 1;
    pages.push(page);
  };

  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]!;
    const isFirst = i === 0;
    const isLast = i === packets.length - 1;
    writePage(packet.data, packet.granule, isFirst ? 0x02 : isLast ? 0x04 : 0x00);
  }

  const total = pages.reduce((sum, page) => sum + page.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.length;
  }
  return out;
}

export function buildOpusHead(channels: number, preSkip: number, inputRate: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  head[8] = 1; // version
  head[9] = channels;
  const view = new DataView(head.buffer);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  view.setUint16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0
  return head;
}

export function buildOpusTags(vendor = "UMRAIO"): Uint8Array {
  const vendorBytes = new TextEncoder().encode(vendor);
  const tags = new Uint8Array(8 + 4 + vendorBytes.length + 4);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  const view = new DataView(tags.buffer);
  view.setUint32(8, vendorBytes.length, true);
  tags.set(vendorBytes, 12);
  view.setUint32(12 + vendorBytes.length, 0, true); // zero user comments
  return tags;
}

/**
 * Encode raw s16le / 24 kHz / mono PCM into a complete OGG/Opus file.
 * The final partial frame is zero-padded so no speech is clipped.
 */
export async function encodePcmToOggOpus(pcm: Uint8Array): Promise<OpusEncodeResult> {
  if (!pcm || pcm.byteLength < 2) return { ok: false, reason: "invalid_pcm" };

  const module = await opusModule();
  if (!module) return { ok: false, reason: "wasm_unavailable" };

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: {
        fd_seek() {},
        fd_write() {},
        fd_close() {},
        proc_exit() {},
      },
      env: { emscripten_notify_memory_growth() {} },
    });
  } catch {
    return { ok: false, reason: "wasm_unavailable" };
  }

  const wasm = instance.exports as unknown as OpusExports;
  let encoderPtr = 0;
  let pcmPtr = 0;
  let outPtr = 0;
  const outCapacity = 4000;

  try {
    encoderPtr = wasm.malloc(wasm.opus_encoder_get_size(PCM_CHANNELS));
    if (
      wasm.opus_encoder_init(encoderPtr, PCM_SAMPLE_RATE, PCM_CHANNELS, OPUS_APPLICATION_VOIP) < 0
    ) {
      return { ok: false, reason: "encode_failed" };
    }
    wasm.opus_encoder_ctl_set(encoderPtr, OPUS_SET_BITRATE, OPUS_TARGET_BITRATE);
    const lookahead = wasm.opus_encoder_ctl_get(encoderPtr, OPUS_GET_LOOKAHEAD);
    const preSkip = Math.max(0, Math.round((lookahead > 0 ? lookahead : 0) * GRANULE_SCALE));

    pcmPtr = wasm.malloc(OPUS_FRAME_SAMPLES * 2);
    outPtr = wasm.malloc(outCapacity);

    const totalSamples = Math.floor(pcm.byteLength / 2);
    const frames = Math.ceil(totalSamples / OPUS_FRAME_SAMPLES);
    const packets: OggPacket[] = [
      { data: buildOpusHead(PCM_CHANNELS, preSkip, PCM_SAMPLE_RATE), granule: 0 },
      { data: buildOpusTags(), granule: 0 },
    ];

    const frame = new Uint8Array(OPUS_FRAME_SAMPLES * 2);
    let granule = 0;
    for (let f = 0; f < frames; f++) {
      const start = f * OPUS_FRAME_SAMPLES * 2;
      const slice = pcm.subarray(start, start + OPUS_FRAME_SAMPLES * 2);
      frame.fill(0);
      frame.set(slice, 0);

      const memory = new Uint8Array(wasm.memory.buffer);
      memory.set(frame, pcmPtr);
      const written = wasm.opus_encode(encoderPtr, pcmPtr, OPUS_FRAME_SAMPLES, outPtr, outCapacity);
      if (written < 0) return { ok: false, reason: "encode_failed" };
      // Re-read the buffer: a growing heap detaches the previous view.
      const after = new Uint8Array(wasm.memory.buffer);
      const data = after.slice(outPtr, outPtr + written);
      granule += OPUS_FRAME_SAMPLES * GRANULE_SCALE;
      packets.push({ data, granule: granule + preSkip });
    }

    if (packets.length <= 2) return { ok: false, reason: "invalid_pcm" };

    try {
      const serial = 0x554d5241; // "UMRA"
      return { ok: true, bytes: muxOggOpus(packets, serial) };
    } catch {
      return { ok: false, reason: "mux_failed" };
    }
  } catch {
    return { ok: false, reason: "encode_failed" };
  } finally {
    try {
      if (pcmPtr) wasm.free(pcmPtr);
      if (outPtr) wasm.free(outPtr);
      if (encoderPtr) wasm.free(encoderPtr);
    } catch {
      /* the instance is discarded with this call anyway */
    }
  }
}
