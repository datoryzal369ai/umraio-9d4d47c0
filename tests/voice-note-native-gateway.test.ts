/**
 * RAIŌ voice note — native media-plane Opus conversion.
 *
 * Covers the signed request contract, response hardening, structural OGG/Opus
 * validation, encoder selection (native gateway in production, local WASM only
 * where the runtime allows it) and the fail-closed policy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GATEWAY_SIGNATURE_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  signGatewayRequest,
} from "@/lib/calls/gateway-auth.core";
import {
  base64ToBytes,
  bytesToBase64,
  encodeOggOpusViaGateway,
  looksLikeOggOpus,
  resolveOpusGatewayConfig,
} from "@/lib/voice/opus-gateway.server";
import { encodePcmToOggOpus, PCM_SAMPLE_RATE } from "@/lib/voice/opus-encode.server";
import { encodeVoiceNotePcm } from "@/lib/voice/voice-note-encode.server";

const SECRET = "gateway-test-secret";
const URL_BASE = "http://127.0.0.1:9/gateway";

function tonePcm(seconds = 0.3): Uint8Array {
  const samples = Math.round(PCM_SAMPLE_RATE * seconds);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(11000 * Math.sin((2 * Math.PI * 220 * i) / PCM_SAMPLE_RATE)), true);
  }
  return bytes;
}

/** A genuine OGG/Opus file, produced by the local encoder. */
async function realOgg(): Promise<Uint8Array> {
  const encoded = await encodePcmToOggOpus(tonePcm(0.4));
  if (!encoded.ok) throw new Error(`fixture encode failed: ${encoded.reason}`);
  return encoded.bytes;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("signed converter request", () => {
  it("posts base64 PCM to /v1/audio/opus with a valid HMAC and timestamp", async () => {
    const ogg = await realOgg();
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ ogg_base64: bytesToBase64(ogg) });
    }) as unknown as typeof fetch;

    const pcm = tonePcm(0.2);
    const now = new Date("2026-09-09T00:00:00Z");
    const result = await encodeOggOpusViaGateway(pcm, {
      gatewayUrl: `${URL_BASE}/`,
      secret: SECRET,
      now,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe(`${URL_BASE}/v1/audio/opus`);
    const headers = call.init.headers as Record<string, string>;
    const ts = Math.floor(now.getTime() / 1000);
    expect(headers[GATEWAY_TIMESTAMP_HEADER]).toBe(String(ts));
    expect(headers[GATEWAY_SIGNATURE_HEADER]).toBe(
      await signGatewayRequest(SECRET, ts, String(call.init.body)),
    );
    // Signed bodies must never follow a redirect.
    expect(call.init.redirect).toBe("error");
    expect(JSON.parse(String(call.init.body))).toEqual({ pcm_base64: bytesToBase64(pcm) });
    expect(String(call.init.body)).not.toContain(SECRET);
  });

  it("never throws and reports why it failed", async () => {
    const bad = [
      { name: "missing_config", args: { gatewayUrl: "", secret: "" }, reason: "gateway_not_configured" },
      {
        name: "network",
        args: {
          gatewayUrl: URL_BASE,
          secret: SECRET,
          fetchImpl: (async () => {
            throw new Error("boom");
          }) as unknown as typeof fetch,
        },
        reason: "gateway_unavailable",
      },
      {
        name: "http_500",
        args: {
          gatewayUrl: URL_BASE,
          secret: SECRET,
          fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
        },
        reason: "gateway_http_500",
      },
      {
        name: "not_json",
        args: {
          gatewayUrl: URL_BASE,
          secret: SECRET,
          fetchImpl: (async () => new Response("<html>")) as unknown as typeof fetch,
        },
        reason: "gateway_invalid_response",
      },
      {
        name: "non_string_field",
        args: {
          gatewayUrl: URL_BASE,
          secret: SECRET,
          fetchImpl: (async () => jsonResponse({ ogg_base64: 12345 })) as unknown as typeof fetch,
        },
        reason: "gateway_invalid_response",
      },
      {
        name: "mp3_blob",
        args: {
          gatewayUrl: URL_BASE,
          secret: SECRET,
          fetchImpl: (async () =>
            jsonResponse({ ogg_base64: bytesToBase64(new Uint8Array(400).fill(0x49)) })) as unknown as typeof fetch,
        },
        reason: "gateway_invalid_container",
      },
      {
        name: "oversized",
        args: {
          gatewayUrl: URL_BASE,
          secret: SECRET,
          fetchImpl: (async () =>
            new Response("{}", {
              headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) },
            })) as unknown as typeof fetch,
        },
        reason: "gateway_response_too_large",
      },
    ];

    for (const item of bad) {
      const result = await encodeOggOpusViaGateway(tonePcm(0.1), item.args as never);
      expect([item.name, result]).toEqual([item.name, { ok: false, reason: item.reason }]);
    }
  });

  it("rejects unusable PCM before making a request", async () => {
    const fetchImpl = vi.fn();
    for (const pcm of [new Uint8Array(0), new Uint8Array(3)]) {
      expect(
        await encodeOggOpusViaGateway(pcm, {
          gatewayUrl: URL_BASE,
          secret: SECRET,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).toEqual({ ok: false, reason: "invalid_pcm" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("container validation", () => {
  it("accepts a complete stream and rejects partial or header-only ones", async () => {
    const ogg = await realOgg();
    expect(looksLikeOggOpus(ogg)).toBe(true);
    // Truncated mid-stream: prefix still says OggS/OpusHead.
    expect(looksLikeOggOpus(ogg.subarray(0, 120))).toBe(false);
    // Header pages only (no audio, no EOS).
    expect(looksLikeOggOpus(ogg.subarray(0, 47))).toBe(false);
    expect(looksLikeOggOpus(new Uint8Array(200))).toBe(false);
    const mp3ish = new Uint8Array(300);
    mp3ish.set([0x49, 0x44, 0x33], 0);
    expect(looksLikeOggOpus(mp3ish)).toBe(false);
  });

  it("base64 round-trips binary audio exactly", async () => {
    const ogg = await realOgg();
    expect(Array.from(base64ToBytes(bytesToBase64(ogg)))).toEqual(Array.from(ogg));
  });
});

describe("encoder selection", () => {
  it("reads the existing server-only binding names", () => {
    expect(resolveOpusGatewayConfig({})).toBeNull();
    expect(resolveOpusGatewayConfig({ WHATSAPP_MEDIA_GATEWAY_URL: URL_BASE })).toBeNull();
    expect(
      resolveOpusGatewayConfig({
        WHATSAPP_MEDIA_GATEWAY_URL: ` ${URL_BASE} `,
        WHATSAPP_MEDIA_GATEWAY_SECRET: ` ${SECRET} `,
      }),
    ).toEqual({ gatewayUrl: URL_BASE, secret: SECRET });
  });

  it("uses the native gateway when configured", async () => {
    const ogg = await realOgg();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ogg_base64: bytesToBase64(ogg) }));

    const out = await encodeVoiceNotePcm(tonePcm(0.2), {
      NODE_ENV: "production",
      WHATSAPP_MEDIA_GATEWAY_URL: URL_BASE,
      WHATSAPP_MEDIA_GATEWAY_SECRET: SECRET,
    });

    expect(out.ok && out.source).toBe("native_gateway");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/v1/audio/opus");
  });

  it("fails closed in production instead of retrying the in-Worker WASM path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 503 }));
    const out = await encodeVoiceNotePcm(tonePcm(0.2), {
      NODE_ENV: "production",
      WHATSAPP_MEDIA_GATEWAY_URL: URL_BASE,
      WHATSAPP_MEDIA_GATEWAY_SECRET: SECRET,
    });
    expect(out).toEqual({ ok: false, reason: "gateway_http_503", source: "native_gateway" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the local encoder only outside production", async () => {
    const out = await encodeVoiceNotePcm(tonePcm(0.3), { NODE_ENV: "development" });
    expect(out.ok && out.source).toBe("local_wasm");
    expect(out.ok && looksLikeOggOpus(out.bytes)).toBe(true);
  });
});
