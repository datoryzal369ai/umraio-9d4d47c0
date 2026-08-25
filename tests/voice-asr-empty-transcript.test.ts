import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractTranscript, transcribeAudio } from "@/lib/voice/asr.server";
import {
  VOICE_INAUDIBLE_MESSAGE,
  fallbackMessageFor,
  isEffectivelyEmptyTranscript,
  normalizeTranscript,
} from "@/lib/voice/limits.core";

const realFetch = globalThis.fetch;
const audio = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "audio/ogg; codecs=opus" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env["AI_PROVIDER"] = "openai";
  process.env["OPENAI_API_KEY"] = "test-key";
  delete process.env["LOVABLE_API_KEY"];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["AI_PROVIDER"];
  delete process.env["OPENAI_API_KEY"];
  vi.restoreAllMocks();
});

describe("ASR — transcript extraction and normalisation", () => {
  it("preserves a valid Malaysian Malay transcript verbatim", () => {
    const raw = "  Assalamualaikum,\n saya nak tanya pakej Umrah RM9,800 seorang  ";
    const text = normalizeTranscript(raw);
    expect(text).toBe("Assalamualaikum, saya nak tanya pakej Umrah RM9,800 seorang");
    expect(isEffectivelyEmptyTranscript(text)).toBe(false);
  });

  it("does not erase transcripts made of digits or code-switched English", () => {
    expect(isEffectivelyEmptyTranscript("4 pax")).toBe(false);
    expect(isEffectivelyEmptyTranscript("ok")).toBe(false);
  });

  it("treats whitespace, punctuation and silence markers as empty", () => {
    expect(isEffectivelyEmptyTranscript("   ")).toBe(true);
    expect(isEffectivelyEmptyTranscript("...")).toBe(true);
    expect(isEffectivelyEmptyTranscript("[silence]")).toBe(true);
    expect(isEffectivelyEmptyTranscript("\u200B")).toBe(true);
  });

  it("reads the documented response shape and tolerated variants", () => {
    expect(extractTranscript({ text: "Salam" })).toBe("Salam");
    expect(extractTranscript({ data: { text: "Salam" } })).toBe("Salam");
    expect(extractTranscript({ segments: [{ text: "Salam" }, { text: "Datuk" }] })).toBe(
      "Salam Datuk",
    );
    expect(extractTranscript({ unexpected: true })).toBeNull();
  });
});

describe("ASR — failure taxonomy", () => {
  it("returns a valid transcript from an OpenAI Direct success", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: "Saya nak pakej Disember" })) as never;
    const result = await transcribeAudio(audio);
    expect(result).toEqual({ ok: true, text: "Saya nak pakej Disember", durationSeconds: null });
  });

  it("classifies a silent recording as empty_transcript, not a pipeline failure", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: "   " })) as never;
    const result = await transcribeAudio(audio);
    expect(result).toEqual({ ok: false, kind: "empty_transcript", status: 200 });
  });

  it("treats a malformed success body as a provider fault and retries, bounded", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ nope: 1 }));
    globalThis.fetch = fetchMock as never;
    const result = await transcribeAudio(audio);
    expect(result).toEqual({ ok: false, kind: "provider", status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers from a transient 500 within the bounded retry budget", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response("boom", { status: 500 }) : jsonResponse({ text: "Salam" });
    }) as never;
    const result = await transcribeAudio(audio);
    expect(result.ok).toBe(true);
    expect(call).toBe(2);
  });

  it("stops after the bounded retry budget on persistent rate limiting", async () => {
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    globalThis.fetch = fetchMock as never;
    const result = await transcribeAudio(audio);
    expect(result).toEqual({ ok: false, kind: "rate_limited", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 400 once with the equivalent container alias before giving up", async () => {
    const names: string[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      const form = (init as { body: FormData }).body;
      const file = form.get("file") as File;
      names.push(file.name);
      return new Response("bad format", { status: 400 });
    }) as never;
    const result = await transcribeAudio(audio);
    expect(names).toEqual(["voice-note.ogg", "voice-note.oga"]);
    expect(result).toEqual({ ok: false, kind: "invalid_audio", status: 400 });
  });

  it("never retries an unconfigured provider chain", async () => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["AI_PROVIDER"];
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const result = await transcribeAudio(audio);
    expect(result).toEqual({ ok: false, kind: "config", status: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Customer-facing voice fallbacks never deny voice support", () => {
  const denial = /(tak|tidak)\s+(ada|boleh)[^.]*(voice|suara)|mesej\s+(bertulis|tulisan)\s+sahaja/i;

  it("asks the customer to resend when the audio was inaudible", () => {
    expect(fallbackMessageFor("inaudible")).toBe(VOICE_INAUDIBLE_MESSAGE);
    expect(VOICE_INAUDIBLE_MESSAGE).not.toMatch(/tuan\/puan|tuan atau puan/i);
    expect(VOICE_INAUDIBLE_MESSAGE).toMatch(/hantar sekali lagi/i);
  });

  it("never claims voice notes are unsupported for any rejection reason", () => {
    for (const reason of [
      "too_large",
      "too_long",
      "empty_audio",
      "unsupported_media",
      "media_unavailable",
      "quota_exceeded",
      "inaudible",
      "asr_failed",
    ] as const) {
      expect(fallbackMessageFor(reason)).not.toMatch(denial);
    }
  });
});
