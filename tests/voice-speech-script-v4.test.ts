import { describe, expect, it } from "vitest";

import {
  limitHonorificRepetition,
  stripWrittenFormatting,
  toSpeechScript,
} from "@/lib/voice/speech-script.core";
import {
  TARGET_SPEECH_CHARS,
  prepareSpokenResponse,
} from "@/lib/voice/presentation.core";
import { DEFAULT_VOICE, DEFAULT_VOICE_INSTRUCTIONS } from "@/lib/voice/tts.server";
import { VOICE_PERSONAS, paceToSpeed, isSupportedTtsVoice } from "@/lib/voice/persona.core";

describe("speech script layer — minimal, no register rewriting", () => {
  it("does NOT invent casual slang or reword formal Malay", () => {
    const script = toSpeechScript(
      "Sekiranya Datuk berminat, pakej tersebut merupakan pilihan terbaik. Selain itu, penginapan berhampiran Masjidil Haram disediakan untuk 4 pax.",
    );
    // wording is preserved exactly — only eye-only shorthand is spoken out
    expect(script).toContain("Sekiranya");
    expect(script).toContain("tersebut");
    expect(script).toContain("penginapan");
    expect(script).not.toContain("lepas tu");
    expect(script).toContain("4 orang");
  });

  it("speaks a title at most once, never in every sentence", () => {
    const out = limitHonorificRepetition(
      "Baik Datuk. Pakej ini sesuai untuk Datuk. Kalau Datuk nak, saya semak tarikh.",
    );
    expect(out.match(/Datuk/g)).toHaveLength(1);
    expect(out).toContain("Kalau nak");
  });

  it("removes markdown, headings and bullets from the spoken script", () => {
    const out = stripWrittenFormatting("## Pakej Umrah\n- **Hotel** dekat Haram\n1. Penerbangan terus");
    expect(out).not.toMatch(/[#*_`~]/);
    expect(out).not.toMatch(/^\s*[-•]/m);
    expect(out).not.toMatch(/^\s*\d+\./m);
    expect(out).toContain("Hotel dekat Haram");
  });

  it("keeps a conversational Malaysian Malay reply intact, facts included", () => {
    const spoken = prepareSpokenResponse({
      replyText:
        "Ya, untuk pakej September ni harganya RM9,800 seorang. Hotel pun dekat dengan Haram. Kalau Datuk nak, saya boleh semak tarikh yang masih ada.",
      language: "ms-MY",
    });
    expect(spoken.spokenText).toContain("sembilan ribu lapan ratus ringgit");
    expect(spoken.spokenText).toContain("September");
    expect(spoken.spokenText.toLowerCase()).toContain("hotel");
    expect(spoken.spokenText).not.toMatch(/RM/);
    expect(spoken.spokenText).not.toMatch(/[*#_`]/);
    expect((spoken.spokenText.match(/Datuk/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(spoken.estimatedSeconds).toBeLessThanOrEqual(25);
  });

  it("shortens a long package answer for speech but preserves the price fact", () => {
    const long = [
      "## Pakej Umrah September",
      "- Harga RM9,800 seorang, berlepas 12 September.",
      "- Hotel berhampiran Masjidil Haram.",
      "Sekiranya Datuk berminat, Datuk boleh maklumkan bilangan peserta.",
      "Selain itu, Datuk juga boleh pilih pakej Disember yang lebih panjang tempohnya dan termasuk lawatan ziarah tambahan di Madinah.",
      "Adakah Datuk mahu saya semak tarikh yang sesuai?",
    ].join("\n");
    const spoken = prepareSpokenResponse({ replyText: long, language: "ms-MY" });
    expect(spoken.spokenText.length).toBeLessThanOrEqual(TARGET_SPEECH_CHARS + 130);
    expect(spoken.spokenText).toContain("sembilan ribu lapan ratus ringgit");
    expect((spoken.spokenText.match(/Datuk/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(spoken.spokenText).not.toMatch(/[-•#*]/);
  });

  it("never invents or drops a capability claim", () => {
    const spoken = prepareSpokenResponse({
      replyText: "Saya boleh hantar nota suara dan mesej di WhatsApp.",
      language: "ms-MY",
    });
    expect(spoken.spokenText.toLowerCase()).toContain("nota suara");
    expect(spoken.spokenText.toLowerCase()).not.toContain("tidak boleh");
  });
});

describe("TTS configuration actually sent to /v1/audio/speech", () => {
  it("uses the natural default voice and a conversational speed", () => {
    expect(DEFAULT_VOICE).toBe("marin");
    expect(isSupportedTtsVoice(DEFAULT_VOICE)).toBe(true);
    expect(paceToSpeed(VOICE_PERSONAS.premium_sales_executive.controls.pace)).toBe(0.97);
    expect(paceToSpeed(0)).toBeGreaterThanOrEqual(0.86);
    expect(paceToSpeed(100)).toBeLessThanOrEqual(1.06);
  });

  it("engine instructions forbid announcer, IVR and sentence-by-sentence reading", () => {
    const text = DEFAULT_VOICE_INSTRUCTIONS.toLowerCase();
    expect(text).toContain("malaysian");
    expect(text).toContain("announcer");
    expect(text).toContain("metronome-like");
  });
});
