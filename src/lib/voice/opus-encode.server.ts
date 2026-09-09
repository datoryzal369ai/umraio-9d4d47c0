/**
 * UMRAIO® VOICE — raw PCM → OGG/Opus encoder (server-only, Worker-safe).
 *
 * WHY: Meta renders a NATIVE WhatsApp voice note only for OGG/Opus. MiniMax
 * returns MP3 (attachment bubble) or raw PCM. This module turns the validated
 * MiniMax PCM (s16le / 24 kHz / mono) into a complete, playable OGG/Opus file
 * with no resampling, no FFmpeg, no child_process and no remote fetch.
 *
 * RUNTIME: libopus is embedded as a base64 string and instantiated in-process.
 * Nothing is imported as a binary asset, fetched, or read from disk, so the
 * server bundle stays plain JavaScript.
 *
 * FAILURE CONTRACT: this module NEVER throws to callers. Every failure returns
 * `{ ok: false }` so the voice reply can fall back to the existing MP3 path.
 */

import { OPUS_WASM_BASE64 } from "./opus/opus-wasm.base64";

/** Opus operates on 20 ms frames; at 24 kHz that is exactly 480 samples. */
export const OPUS_FRAME_SAMPLES = 480;
export const PCM_SAMPLE_RATE = 24_000;
export const PCM_CHANNELS = 1;
/** Ogg granule positions are ALWAYS expressed at 48 kHz, whatever the input rate. */
const GRANULE_RATE = 48_000;
const GRANULE_SCALE = GRANULE_RATE / PCM_SAMPLE_RATE;
/** OPUS_GET_LOOKAHEAD_REQUEST */
const OPUS_GET_LOOKAHEAD = 4027;
/** OPUS_SET_BITRATE_REQUEST. */
const OPUS_SET_BITRATE = 4002;
/** OPUS_SET_COMPLEXITY_REQUEST — 10 = maximum analysis quality. */
const OPUS_SET_COMPLEXITY = 4010;
/** OPUS_SET_BANDWIDTH_REQUEST. */
const OPUS_SET_BANDWIDTH = 4008;
/** OPUS_BANDWIDTH_FULLBAND — preserve the widest possible speech bandwidth. */
const OPUS_BANDWIDTH_FULLBAND = 1105;
/**
 * QUALITY FIX: OPUS_APPLICATION_AUDIO + 48 kbps + complexity 10 + fullband.
 * The previous VOIP/24 kbps/default-complexity profile produced a robotic,
 * narrowband-sounding RAIŌ voice note. AUDIO mode keeps the natural timbre.
 */
const OPUS_APPLICATION_AUDIO = 2049;
const OPUS_TARGET_BITRATE = 48_000;
const OPUS_COMPLEXITY = 10;

/** Exported for regression tests that lock the voice-quality settings. */
export const OPUS_QUALITY_SETTINGS = {
  application: OPUS_APPLICATION_AUDIO,
  bitrate: OPUS_TARGET_BITRATE,
  complexity: OPUS_COMPLEXITY,
  bandwidth: OPUS_BANDWIDTH_FULLBAND,
} as const;

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

let exportsPromise: Promise<OpusExports | null> | null = null;
let wasmSource: "compiled_module" | "hosted_asset" | "runtime_compile" | "unavailable" =
  "unavailable";

/** Which loader produced the encoder — non-secret diagnostic for the probe. */
export function opusWasmSource(): string {
  return wasmSource;
}

/**
 * WASI/env stubs required by the embedded libopus build. None of these
 * functions is ever actually called.
 */
export const OPUS_IMPORTS: WebAssembly.Imports = {
  wasi_snapshot_preview1: {
    fd_seek: () => 0,
    fd_write: () => 0,
    fd_close: () => 0,
    proc_exit: () => {},
  },
  env: { emscripten_notify_memory_growth: () => {} },
};

function finishInstance(instance: WebAssembly.Instance): OpusExports {
  const exports = instance.exports as unknown as OpusExports & { _initialize?: () => void };
  try {
    exports._initialize?.();
  } catch {
    /* already initialised */
  }
  return exports;
}

/**
 * MODULE SOURCE ORDER
 *
 * 1. PRECOMPILED MODULE IMPORT (production). The serverless runtime forbids
 *    compiling WebAssembly from bytes at runtime ("Wasm code generation
 *    disallowed by embedder"), so `fetch(...)` + `WebAssembly.instantiate(bytes)`
 *    can NEVER work there. The supported path is importing the `.wasm` file so
 *    the bundler ships an already-compiled `WebAssembly.Module`, which may be
 *    instantiated at runtime. The import is dynamic so Node/vitest, where the
 *    loader has no `.wasm` handler, simply fall through.
 * 2. Hosted asset fetch, then the embedded base64 build — both compile from
 *    bytes and therefore only apply to dev/node/test runtimes.
 */
async function instantiateFromBytes(bytes: Uint8Array<ArrayBuffer>): Promise<OpusExports | null> {
  try {
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      OPUS_IMPORTS,
    )) as WebAssembly.WebAssemblyInstantiatedSource;
    return finishInstance(instance);
  } catch {
    return null;
  }
}

/**
 * STAGED LOADER DIAGNOSTICS
 *
 * Every loader attempt records a sanitized stage record so a failure can be
 * attributed exactly (asset missing vs. import rejected vs. wrong value type vs.
 * instantiate/import-object mismatch vs. embedder code-generation ban) instead
 * of collapsing into a single ambiguous `not_packaged`. No secret, env value or
 * audio content is ever recorded.
 */
export type OpusLoaderStage = {
  stage: string;
  ok: boolean;
  detail?: string;
};

let loaderStages: OpusLoaderStage[] = [];

export function opusLoaderStages(): OpusLoaderStage[] {
  return loaderStages;
}

function note(stage: string, ok: boolean, detail?: string) {
  loaderStages.push(detail ? { stage, ok, detail } : { stage, ok });
}

/** Error text without paths that could leak deployment internals. */
function sanitize(error: unknown): string {
  const err = error as Error | undefined;
  const name = err?.name ?? "Error";
  const message = String(err?.message ?? error ?? "unknown")
    .replace(/[A-Za-z]:\\[^\s]+|\/[^\s]*\//g, "<path>")
    .slice(0, 200);
  return `${name}: ${message}`;
}

async function loadCompiledModule(): Promise<OpusExports | null> {
  let mod: unknown;
  try {
    mod = ((await import("./opus/opus.wasm?cfmodule")) as { default?: unknown }).default;
    note("module_import", true);
  } catch (error) {
    note("module_import", false, sanitize(error));
    return null;
  }

  const kind = mod === null || mod === undefined ? String(mod) : typeof mod;
  const ctor = (mod as { constructor?: { name?: string } })?.constructor?.name ?? "none";
  const isModule = mod instanceof WebAssembly.Module;
  note("module_type", isModule, `typeof=${kind} constructor=${ctor} instanceof_Module=${isModule}`);
  if (!isModule) return null;

  try {
    const instance = await WebAssembly.instantiate(mod as WebAssembly.Module, OPUS_IMPORTS);
    note("module_instantiate", true);
    wasmSource = "compiled_module";
    return finishInstance(instance);
  } catch (error) {
    note("module_instantiate", false, sanitize(error));
    return null;
  }
}

async function loadHostedModule(): Promise<OpusExports | null> {
  const origin = process.env["PUBLIC_SITE_URL"] ?? "https://umraio.com";
  try {
    const response = await fetch(`${origin}/wasm/opus.wasm`);
    note("hosted_fetch", response.ok, `status=${response.status}`);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    note("hosted_bytes", buffer.byteLength > 0, `bytes=${buffer.byteLength}`);
    const exports = await instantiateFromBytes(new Uint8Array(buffer));
    note("hosted_instantiate", Boolean(exports));
    if (exports) wasmSource = "hosted_asset";
    return exports;
  } catch (error) {
    note("hosted_fetch", false, sanitize(error));
    return null;
  }
}

/**
 * Byte-compilation is impossible in the serverless runtime, so in production the
 * precompiled module is the ONLY accepted source. Falling through to the hosted
 * or embedded byte paths there would just fail slowly and hide the real cause,
 * so the encoder reports unavailable and the voice note fails closed instead.
 */
export function opusAllowsByteCompilation(): boolean {
  return process.env["NODE_ENV"] !== "production";
}

async function loadOpusExports(): Promise<OpusExports | null> {
  loaderStages = [];
  note("embedded_asset", OPUS_WASM_BASE64.length > 0, `base64_chars=${OPUS_WASM_BASE64.length}`);

  const compiled = await loadCompiledModule();
  if (compiled) return compiled;
  if (!opusAllowsByteCompilation()) {
    wasmSource = "unavailable";
    const last = loaderStages.filter((s) => !s.ok).at(-1);
    console.error(
      `[voice] opus_wasm_unavailable source=compiled_module stage=${last?.stage ?? "unknown"} detail=${last?.detail ?? "none"}`,
    );
    return null;
  }
  const hosted = await loadHostedModule();
  if (hosted) return hosted;
  try {
    // Runtimes that still allow compiling from bytes (node, vitest, dev).
    const { instance } = await WebAssembly.instantiate(
      base64ToBytes(OPUS_WASM_BASE64),
      OPUS_IMPORTS,
    );
    note("base64_instantiate", true);
    wasmSource = "runtime_compile";
    return finishInstance(instance);
  } catch (error) {
    note("base64_instantiate", false, sanitize(error));
    wasmSource = "unavailable";
    console.error(`[voice] opus_wasm_instantiate_failed source=base64 reason=${sanitize(error)}`);
    return null;
  }
}



function opusExports(): Promise<OpusExports | null> {
  if (!exportsPromise) exportsPromise = loadOpusExports();
  return exportsPromise;
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

  const wasm = await opusExports();
  if (!wasm) return { ok: false, reason: "wasm_unavailable" };

  let encoderPtr = 0;
  let pcmPtr = 0;
  let outPtr = 0;
  const outCapacity = 4000;

  try {
    encoderPtr = wasm.malloc(wasm.opus_encoder_get_size(PCM_CHANNELS));
    if (
      wasm.opus_encoder_init(encoderPtr, PCM_SAMPLE_RATE, PCM_CHANNELS, OPUS_APPLICATION_AUDIO) < 0
    ) {
      return { ok: false, reason: "encode_failed" };
    }
    wasm.opus_encoder_ctl_set(encoderPtr, OPUS_SET_BITRATE, OPUS_TARGET_BITRATE);
    // Best-effort quality controls: ignore failures so older libopus builds
    // still encode rather than breaking the whole voice-note path.
    wasm.opus_encoder_ctl_set(encoderPtr, OPUS_SET_COMPLEXITY, OPUS_COMPLEXITY);
    wasm.opus_encoder_ctl_set(encoderPtr, OPUS_SET_BANDWIDTH, OPUS_BANDWIDTH_FULLBAND);
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
