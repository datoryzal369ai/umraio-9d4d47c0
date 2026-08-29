import { afterEach, describe, expect, it, vi } from "vitest";

import {
  XIAOZHI_TTS_MAX_ATTEMPTS,
  XIAOZHI_TTS_TIMEOUT_MS,
  synthesizeSpeech,
  xiaozhiVoiceEngine,
} from "@/lib/voice/tts.server";

const realFetch = globalThis.fetch;
const ENDPOINT = "https://xiaozhi.internal/tts";

function audioResponse(status = 200, mime = "audio/ogg", bytes = new Uint8Array([1, 2, 3])) {
  return new Response(bytes, { status, headers: { "content-type": mime } });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["XIAOZHI_TTS_URL"];
  delete process.env["XIAOZHI_TTS_API_KEY"];
  delete process.env["AI_PROVIDER"];
  delete process.env["LOVABLE_API_KEY"];
  vi.restoreAllMocks();
});

describe("XIAOZHI TTS HARDENING", () => {
  it("constants: 8s bounded timeout, at most one retry", () => {
    expect(XIAOZHI_TTS_TIMEOUT_MS).toBe(8_000);
    expect(XIAOZHI_TTS_MAX_ATTEMPTS).toBe(2);
  });

  it("XiaoZhi success is returned without any retry", async () => {
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const spy = vi.fn(async () => audioResponse());
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
      engine: "xiaozhi",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("missing XIAOZHI_TTS_URL stays inert with zero network calls", async () => {
    const spy = vi.fn(async () => audioResponse());
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "unsupported_engine", engine: "xiaozhi" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an invalid endpoint URL is a permanent configuration failure", async () => {
    process.env["XIAOZHI_TTS_URL"] = "ftp://not-http/tts";
    const spy = vi.fn(async () => audioResponse());
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "config", engine: "xiaozhi" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("timeout aborts at 8s, retries once, then fails over to the proven provider", async () => {
    process.env["AI_PROVIDER"] = "lovable";
    process.env["LOVABLE_API_KEY"] = "test-key";
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("xiaozhi")) {
        // Hang until the driver's AbortController fires.
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      return audioResponse();
    }) as unknown as typeof fetch;

    const result = await synthesizeSpeech({ text: "Salam", provider: "xiaozhi" });
    expect(result.ok && result.engine).toBe("lovable");
    // Hung XiaoZhi attempt 1 + retry attempt 2, then OpenAI/Lovable fallback.
    expect(calls.filter((u) => u.includes("xiaozhi"))).toHaveLength(2);
    expect(calls).toHaveLength(3);
  }, 30_000);

  it("401 is unauthorized, never retried, and fails over", async () => {
    process.env["AI_PROVIDER"] = "lovable";
    process.env["LOVABLE_API_KEY"] = "test-key";
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("xiaozhi")) return new Response("denied", { status: 401 });
      return audioResponse();
    }) as unknown as typeof fetch;

    const result = await synthesizeSpeech({ text: "Salam", provider: "xiaozhi" });
    expect(result.ok && result.engine).toBe("lovable");
    expect(calls.filter((u) => u.includes("xiaozhi"))).toHaveLength(1);
  });

  it("403 is unauthorized and never retried", async () => {
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const spy = vi.fn(async () => new Response("denied", { status: 403 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "unauthorized", engine: "xiaozhi" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("429 is rate_limited with a bounded single retry, then failover", async () => {
    process.env["AI_PROVIDER"] = "lovable";
    process.env["LOVABLE_API_KEY"] = "test-key";
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("xiaozhi")) return new Response("slow down", { status: 429 });
      return audioResponse();
    }) as unknown as typeof fetch;

    const result = await synthesizeSpeech({ text: "Salam", provider: "xiaozhi" });
    expect(result.ok && result.engine).toBe("lovable");
    expect(calls.filter((u) => u.includes("xiaozhi"))).toHaveLength(2);
  });

  it("network errors retry exactly once and are classified as provider", async () => {
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const spy = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "provider", engine: "xiaozhi" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("p3/device-framed octet-stream audio is rejected as invalid_audio without retry", async () => {
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const spy = vi.fn(async () => audioResponse(200, "application/octet-stream"));
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "invalid_audio", engine: "xiaozhi" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("empty audio is rejected as invalid_audio without retry", async () => {
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const spy = vi.fn(async () => audioResponse(200, "audio/ogg", new Uint8Array(0)));
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "invalid_audio", engine: "xiaozhi" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("credentials never appear in logs or errors", async () => {
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    process.env["XIAOZHI_TTS_API_KEY"] = "xz-super-secret-key";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let sawAuthHeader = false;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sawAuthHeader = headers["Authorization"] === "Bearer xz-super-secret-key";
      return new Response("denied", { status: 401 });
    }) as unknown as typeof fetch;

    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result.ok).toBe(false);
    expect(sawAuthHeader).toBe(true); // key IS sent on the wire
    const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().join(" ");
    expect(logged).not.toContain("xz-super-secret-key");
    expect(logged).not.toContain("Authorization");
    expect(JSON.stringify(result)).not.toContain("xz-super-secret-key");
  });

  it("strict AI_PROVIDER=openai keeps the xiaozhi → openai chain with no Lovable", async () => {
    process.env["AI_PROVIDER"] = "openai";
    process.env["XIAOZHI_TTS_URL"] = ENDPOINT;
    const { selectVoiceProviderChain } = await import("@/lib/voice/tts.server");
    expect(selectVoiceProviderChain("xiaozhi").map((e) => e.name)).toEqual(["xiaozhi", "openai"]);
    expect(selectVoiceProviderChain().map((e) => e.name)).toEqual(["openai"]);
  });
});
