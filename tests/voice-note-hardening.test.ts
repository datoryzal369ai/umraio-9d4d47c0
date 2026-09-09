/**
 * RAIŌ voice note — coordinator review hardening.
 *
 * These are the exact defects reviewed on the native converter diff:
 * production must never fall through to the local encoder, entry-point PCM
 * validation, container validation that cannot throw on hostile peer bytes,
 * and a public probe that cannot reach the production media plane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { looksLikeOggOpus, isLoopbackGatewayUrl } from "@/lib/voice/opus-gateway.server";
import {
  encodeVoiceNotePcm,
  MAX_VOICE_NOTE_PCM_BYTES,
} from "@/lib/voice/voice-note-encode.server";

const FLY_URL = "https://umraio-voice-gateway.fly.dev";

afterEach(() => vi.restoreAllMocks());

describe("entry-point PCM validation", () => {
  it("rejects odd-length PCM before any encoder is selected", async () => {
    const out = await encodeVoiceNotePcm(new Uint8Array(9), { NODE_ENV: "production" });
    expect(out).toEqual({ ok: false, reason: "invalid_pcm", source: "unavailable" });
  });

  it("rejects oversized PCM before any encoder is selected", async () => {
    const out = await encodeVoiceNotePcm(new Uint8Array(MAX_VOICE_NOTE_PCM_BYTES + 2), {
      NODE_ENV: "production",
    });
    expect(out).toEqual({ ok: false, reason: "pcm_too_large", source: "unavailable" });
  });
});

describe("production without a media plane", () => {
  it("fails closed as gateway_not_configured and never tries the local encoder", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await encodeVoiceNotePcm(new Uint8Array(4800), {
      NODE_ENV: "production",
      WHATSAPP_MEDIA_GATEWAY_URL: "",
      WHATSAPP_MEDIA_GATEWAY_SECRET: "",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("gateway_not_configured");
      expect(out.source).toBe("native_gateway");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("container validation never throws on hostile input", () => {
  const hostile: Record<string, Uint8Array> = {};
  // >=100 bytes, valid magic, segment count 255 — the old DataView read here
  // threw a RangeError instead of rejecting the blob.
  const oversizedSegments = new Uint8Array(120);
  oversizedSegments.set([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
  oversizedSegments[26] = 255;
  hostile["segment_table_overflow"] = oversizedSegments;

  const truncatedHead = new Uint8Array(150);
  truncatedHead.set([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
  truncatedHead[26] = 1;
  truncatedHead[27] = 200; // payload longer than the buffer
  hostile["payload_overflow"] = truncatedHead;

  hostile["random_noise"] = new Uint8Array(512).map((_, i) => (i * 37) % 251);
  hostile["short"] = new Uint8Array(12);

  for (const [name, bytes] of Object.entries(hostile)) {
    it(`rejects ${name} without throwing`, () => {
      expect(() => looksLikeOggOpus(bytes)).not.toThrow();
      expect(looksLikeOggOpus(bytes)).toBe(false);
    });
  }
});

describe("probe loopback guard", () => {
  it("treats the production media-plane URL as non-loopback", () => {
    expect(isLoopbackGatewayUrl(FLY_URL)).toBe(false);
    expect(isLoopbackGatewayUrl("https://example.com")).toBe(false);
    expect(isLoopbackGatewayUrl("ftp://127.0.0.1")).toBe(false);
    expect(isLoopbackGatewayUrl(undefined)).toBe(false);
    expect(isLoopbackGatewayUrl("not a url")).toBe(false);
    expect(isLoopbackGatewayUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackGatewayUrl("http://localhost:8080/")).toBe(true);
    expect(isLoopbackGatewayUrl("http://[::1]:8080")).toBe(true);
  });

  it("makes no request when the opt-in flag is set but the URL is the production plane", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env["OPUS_PROBE_ALLOW_GATEWAY"] = "1";
    process.env["WHATSAPP_MEDIA_GATEWAY_URL"] = FLY_URL;
    process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"] = "not-used";
    try {
      const { Route } = await import("@/routes/api/public/health/opus-probe");
      const handler = (
        Route.options as unknown as {
          server: { handlers: { GET: (a: { request: Request }) => Promise<Response> } };
        }
      ).server.handlers.GET;
      const res = await handler({
        request: new Request("https://umraio.com/api/public/health/opus-probe?mode=gateway"),
      });
      const body = (await res.json()) as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("gateway_probe_non_loopback");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env["OPUS_PROBE_ALLOW_GATEWAY"];
      delete process.env["WHATSAPP_MEDIA_GATEWAY_URL"];
      delete process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"];
    }
  });
});
