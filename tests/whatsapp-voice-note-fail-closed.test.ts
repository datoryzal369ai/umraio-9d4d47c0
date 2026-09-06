import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RAIŌ WhatsApp Voice Note must be MiniMax-only. A MiniMax failure leaves the
 * turn text-only — it never reroutes to another provider's voice.
 */
describe("whatsapp voice note fail-closed", () => {
  it("exposes MiniMax as the voice-note engine", async () => {
    const { whatsappVoiceNoteEngine } = await import("@/lib/voice/tts.server");
    expect(whatsappVoiceNoteEngine.name).toBe("minimax");
  });

  it("does not fall back to another provider when MiniMax fails", async () => {
    const { synthesizeSpeech, whatsappVoiceNoteEngine } = await import("@/lib/voice/tts.server");
    const spy = vi
      .spyOn(whatsappVoiceNoteEngine, "synthesize")
      .mockResolvedValue({ ok: false, kind: "provider", engine: "minimax" });

    const result = await synthesizeSpeech({
      text: "Assalamualaikum",
      language: "ms",
      requireOggOpus: true,
      engine: whatsappVoiceNoteEngine,
    });

    expect(result.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("keeps the voice-note call site MiniMax-only and OGG/Opus", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/routes/api/public/whatsapp.ts", "utf8"),
    );
    expect(source).toContain("engine: whatsappVoiceNoteEngine");
    expect(source).toContain("requireOggOpus: true");
  });
});

describe("production opus loader selection", () => {
  const original = process.env["NODE_ENV"];
  afterEach(() => {
    if (original === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = original;
  });

  it("only accepts the precompiled module in production", async () => {
    const { opusAllowsByteCompilation } = await import("../src/lib/voice/opus-encode.server");
    process.env["NODE_ENV"] = "production";
    expect(opusAllowsByteCompilation()).toBe(false);
  });

  it("still allows byte compilation in dev and test runtimes", async () => {
    const { opusAllowsByteCompilation } = await import("../src/lib/voice/opus-encode.server");
    process.env["NODE_ENV"] = "development";
    expect(opusAllowsByteCompilation()).toBe(true);
  });

  it("keeps the wasm binary packaged for the worker build", async () => {
    const { stat } = await import("node:fs/promises");
    const info = await stat("src/lib/voice/opus/opus.wasm");
    expect(info.size).toBeGreaterThan(100_000);
  });
});
