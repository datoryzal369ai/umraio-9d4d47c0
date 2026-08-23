import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOICE_LANGUAGE,
  asrLanguageFor,
  languageInstruction,
  resolveVoiceLanguage,
  usesMalayNormalisation,
} from "@/lib/voice/language.core";
import { VOICE_QUOTA_MESSAGE, fallbackMessageFor } from "@/lib/voice/limits.core";
import { normaliseMalaySpeech } from "@/lib/voice/malay-speech.core";
import { buildVoiceInstructions, VOICE_PERSONAS } from "@/lib/voice/persona.core";
import { prepareSpokenResponse } from "@/lib/voice/presentation.core";

describe("voice language resolution", () => {
  it("defaults to Malaysian Malay when unset or unknown", () => {
    expect(resolveVoiceLanguage(null)).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(resolveVoiceLanguage("")).toBe("ms-MY");
    expect(resolveVoiceLanguage("klingon")).toBe("ms-MY");
    expect(resolveVoiceLanguage("ms")).toBe("ms-MY");
  });

  it("keeps explicit selections", () => {
    expect(resolveVoiceLanguage("en-US")).toBe("en-US");
    expect(resolveVoiceLanguage("auto")).toBe("auto");
  });

  it("gives an ISO hint for fixed languages and none for auto", () => {
    expect(asrLanguageFor("ms-MY")).toBe("ms");
    expect(asrLanguageFor("en-US")).toBe("en");
    expect(asrLanguageFor("auto")).toBeNull();
  });

  it("enforces Malaysian Malay and forbids Indonesian drift", () => {
    const instruction = languageInstruction("ms-MY");
    expect(instruction).toContain("Malaysian Malay");
    expect(instruction).toContain("Bahasa Indonesia");
    expect(instruction.toLowerCase()).toContain("do not");
  });

  it("only applies Malay normalisation to Malay", () => {
    expect(usesMalayNormalisation(null)).toBe(true);
    expect(usesMalayNormalisation("en-US")).toBe(false);
  });
});

describe("persona instructions", () => {
  it("carries the language instruction", () => {
    const instructions = buildVoiceInstructions(
      VOICE_PERSONAS.premium_sales_executive.controls,
      "en-US",
    );
    expect(instructions).toContain("English");
  });
});

describe("spoken preparation", () => {
  it("speaks Malay numbers, prices and dates", () => {
    const prepared = prepareSpokenResponse({
      replyText: "Harga RM5,990 seorang. Berlepas 23/12/2026.",
      persona: { persona: "premium_sales_executive" },
      language: "ms-MY",
    });
    expect(prepared.spokenText).toContain("ringgit");
    expect(prepared.spokenText).toContain("Disember");
  });

  it("leaves English text unnormalised", () => {
    const prepared = prepareSpokenResponse({
      replyText: "The package is RM5,990 per person.",
      persona: { persona: "professional" },
      language: "en-US",
    });
    expect(prepared.spokenText).toContain("5,990");
  });

  it("speaks decimals as one number, not two", () => {
    expect(normaliseMalaySpeech("Jaraknya 3.5 kilometer")).toContain("tiga perpuluhan lima");
  });
});

describe("quota truthfulness", () => {
  it("uses a distinct, honest quota message", () => {
    expect(fallbackMessageFor("quota_exceeded")).toBe(VOICE_QUOTA_MESSAGE);
    expect(VOICE_QUOTA_MESSAGE).not.toBe(fallbackMessageFor("asr_failed"));
    expect(VOICE_QUOTA_MESSAGE.toLowerCase()).toContain("had");
  });
});
