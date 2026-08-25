import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VOICE_PERSONA,
  VOICE_PERSONAS,
  buildVoiceInstructions,
  isSupportedTtsVoice,
  paceToSpeed,
  resolvePersona,
} from "@/lib/voice/persona.core";
import {
  TARGET_SPEECH_CHARS,
  prepareSpokenResponse,
} from "@/lib/voice/presentation.core";
import { normaliseMalaySpeech } from "@/lib/voice/malay-speech.core";
import { selectVoiceProviderChain } from "@/lib/voice/tts.server";

afterEach(() => {
  delete process.env["AI_PROVIDER"];
});

describe("VOICE NATURALNESS V3", () => {
  it("every persona voice is accepted by the live TTS engine", () => {
    for (const persona of Object.values(VOICE_PERSONAS)) {
      expect(isSupportedTtsVoice(persona.voice)).toBe(true);
    }
    expect(VOICE_PERSONAS[DEFAULT_VOICE_PERSONA].voice).toBe("marin");
  });

  it("an unsupported custom voice falls back to the persona voice", () => {
    expect(resolvePersona({ voice: "not-a-voice" }).voice).toBe("marin");
    expect(resolvePersona({ voice: "Cedar" }).voice).toBe("cedar");
  });

  it("speed stays inside a conversational band", () => {
    expect(paceToSpeed(0)).toBeGreaterThanOrEqual(0.86);
    expect(paceToSpeed(100)).toBeLessThanOrEqual(1.06);
  });

  it("strict OpenAI mode never chains the Lovable gateway", () => {
    process.env["AI_PROVIDER"] = "openai";
    expect(selectVoiceProviderChain("xiaozhi").map((e) => e.name)).toEqual(["xiaozhi", "openai"]);
    expect(selectVoiceProviderChain().map((e) => e.name)).toEqual(["openai"]);
  });

  it("a long answer is condensed to the 10-18s target at sentence boundaries", () => {
    const long = Array.from(
      { length: 8 },
      (_, i) => `Pakej ini termasuk penerbangan terus dan hotel berdekatan Masjidil Haram nombor ${i + 1}.`,
    ).join(" ") + " Boleh saya semak tarikh yang sesuai untuk tuan?";
    const spoken = prepareSpokenResponse({ replyText: long, language: "ms-MY" });
    expect(spoken.spokenText.length).toBeLessThanOrEqual(TARGET_SPEECH_CHARS + 60);
    expect(spoken.spokenText.trim().endsWith("?")).toBe(true);
    expect(spoken.estimatedSeconds).toBeLessThanOrEqual(22);
  });

  it("instructions forbid announcer and metronome delivery", () => {
    const text = buildVoiceInstructions(VOICE_PERSONAS.premium_sales_executive.controls, "ms-MY");
    expect(text.toLowerCase()).toContain("metronome-like");
    expect(text.toLowerCase()).toContain("audiobook-narrator");
  });

  it("Malay normalisation speaks Umrah shorthand and clock forms correctly", () => {
    expect(normaliseMalaySpeech("4 pax")).toContain("orang");
    expect(normaliseMalaySpeech("berlepas 12 Dis")).toContain("Disember");
    expect(normaliseMalaySpeech("berkumpul 8.45 pagi")).toContain("pukul");
    expect(normaliseMalaySpeech("berkumpul 8.45 pagi")).not.toContain("perpuluhan");
    expect(normaliseMalaySpeech("harga RM6,990")).toContain("ringgit");
  });
});
