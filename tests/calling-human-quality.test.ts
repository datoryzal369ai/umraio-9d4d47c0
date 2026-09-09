import { afterEach, describe, expect, it, vi } from "vitest";
import { callingSpokenText, withCallingBackchannel } from "@/lib/calls/call-backchannel.core";
import { callingTurnResponse } from "@/lib/calls/call-stream.server";
import { advanceClosing, buildCallOpening } from "@/lib/calls/call-experience.core";
import { buildAcknowledgement, resolveAddress } from "@/lib/calls/cognitive-router.core";

afterEach(() => vi.useRealTimers());
describe("Calling backchannel timing", () => {
  it("delivers acknowledgement before a delayed substantive answer", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const emit = vi.fn();
    const work = withCallingBackchannel({ answer: new Promise<string>(r => { finish = r; }), emit });
    await vi.advanceTimersByTimeAsync(349);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledTimes(1);
    finish("Jawapan sebenar");
    expect(await work).toEqual({ answer: "Jawapan sebenar", emitted: true });
  });
  it("does not add filler when the answer is already ready", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    await withCallingBackchannel({ answer: Promise.resolve("Jawapan"), emit });
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit).not.toHaveBeenCalled();
  });
  it("suppresses a delayed acknowledgement after caller cancellation", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let finish!: (value: string) => void;
    const emit = vi.fn();
    const work = withCallingBackchannel({ answer: new Promise<string>(r => { finish = r; }), emit, signal: abort.signal });
    abort.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit).not.toHaveBeenCalled();
    finish("stale");
    await expect(work).rejects.toThrow();
  });
});

describe("Calling control response compatibility", () => {
  const final = { ok: true as const, text: "Jawapan", replyOggBase64: null, endCall: false, voiceId: "Malay_male_1_v1", languageBoost: "Malay" };
  it("streams an ACK before the final result exists", async () => {
    let finish!: (value: typeof final) => void;
    const response = await callingTurnResponse({ streaming: true, signal: new AbortController().signal,
      run: async emit => { emit?.({ text: "Baik, sekejap ya.", voiceId: final.voiceId, languageBoost: final.languageBoost }); return new Promise(r => { finish = r; }); } });
    const reader = response.body!.getReader();
    const ack = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    expect(ack).toMatchObject({ type: "ack", end_call: false, voice_id: final.voiceId });
    finish(final);
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toMatchObject({ type: "final", speech_text: "Jawapan" });
    expect((await reader.read()).done).toBe(true);
  });
  it("keeps legacy JSON clients and the locked voice identity working", async () => {
    const response = await callingTurnResponse({ streaming: false, signal: new AbortController().signal,
      run: async emit => { expect(emit).toBeUndefined(); return final; } });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ speech_text: "Jawapan", voice_id: final.voiceId, end_call: false });
  });
  it("cancels the producer when the caller closes the stream", async () => {
    let signal!: AbortSignal;
    let finish!: (value: typeof final) => void;
    const response = await callingTurnResponse({ streaming: true, signal: new AbortController().signal,
      run: async (_, current) => { signal = current; return new Promise(r => { finish = r; }); } });
    await response.body!.cancel();
    expect(signal.aborted).toBe(true);
    finish(final);
  });
});

describe("Spoken Calling presentation and completion", () => {
  const base = { state: "active" as const, language: "ms-MY", turnCount: 3, maxTurns: 60 };
  it.each(["okay terima kasih", "baik itu sahaja", "dah cukup", "okay bye", "terima kasih ya", "dah tak ada", "itu sahaja", "terima kasih", "tak ada apa lagi", "tak ada apa-apa lagi", "tak ada dah"])("closes genuine completion: %s", transcript => {
    const result = advanceClosing({ ...base, transcript });
    expect(result.action).toBe("farewell");
    if (result.action === "farewell") expect(result.text.length).toBeLessThan(85);
  });
  it.each(["Terima kasih, saya nak tanya satu lagi", "Okay terima kasih, berapa harga pakej?", "Jangan putuskan talian dulu", "Saya nak putuskan tempahan umrah saya", "Dah tak ada bilik?", "Tak ada apa lagi yang saya perlu bayar?", "Itu sahaja harga dia?", "Terima kasih, tunggu saya cari dokumen"])("keeps an active conversation open: %s", transcript => {
    expect(advanceClosing({ ...base, transcript }).action).not.toBe("farewell");
  });
  it("preserves pending-work protection for an incidental thank-you", () => {
    expect(advanceClosing({ ...base, transcript: "okay terima kasih", pendingWork: true }).action).toBe("continue");
  });
  it("never asks anything else or repeats farewell after commitment without fresh caller speech", () => {
    const closing = advanceClosing({ ...base, transcript: "dah tak ada" });
    expect(closing.action).toBe("farewell");
    for (let i = 0; i < 20; i++) {
      expect(advanceClosing({ ...base, state: closing.state, transcript: "", turnCount: base.maxTurns + i }))
        .toEqual({ action: "await_termination", state: "farewell" });
    }
  });
  it("allows the caller to independently resume before termination", () => {
    expect(advanceClosing({ ...base, state: "farewell", transcript: "Tunggu, saya nak tanya satu lagi" }))
      .toEqual({ action: "continue", state: "active" });
  });
  it("varies openings, retains disclosure and only uses known names", () => {
    const openings = [0, 1, 2].map(variant => buildCallOpening({ agencyName: "AGENCY", language: "ms-MY", variant }).text);
    expect(new Set(openings).size).toBe(3);
    for (const text of openings) { expect(text).toContain("dirakam"); expect(text).toContain("AI"); expect(text).not.toMatch(/Dato|Datuk/); }
  });
  it("varies short ACKs and preserves a stored honorific", () => {
    const address = resolveAddress("Dato’ Ryzal");
    expect(address.honorific).toBe("Dato'");
    const phrases = [0, 1, 2].map(seed => buildAcknowledgement({ address, language: "ms-MY", seed }));
    expect(new Set(phrases).size).toBe(3);
    for (const text of phrases) { expect(text).toContain("Dato'"); expect(text).not.toMatch(/\bsemak\b/i); }
  });
  it("applies the pronunciation rule only to Calling presentation", () => {
    expect(callingSpokenText("Saya semak dulu. SEMAK sekarang.")).toBe("Saya periksa dulu. periksa sekarang.");
  });
});
