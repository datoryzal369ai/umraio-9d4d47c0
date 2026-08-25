import { describe, expect, it } from "vitest";

import {
  malayCurrency,
  malayDate,
  malayNumber,
  normaliseMalaySpeech,
} from "@/lib/voice/malay-speech.core";
import {
  DEFAULT_VOICE_PERSONA,
  UNSUPPORTED_ENGINE_CONTROLS,
  VOICE_CONTROL_KEYS,
  VOICE_CONTROL_SUPPORT,
  VOICE_PERSONAS,
  buildVoiceInstructions,
  paceToSpeed,
  resolvePersona,
} from "@/lib/voice/persona.core";
import {
  classifySpokenLength,
  decideVoiceReply,
  isDeliverableAudio,
  prepareSpokenResponse,
  stripForSpeech,
} from "@/lib/voice/presentation.core";
import { toSpeakableText } from "@/lib/voice/tts.core";
import { xiaozhiVoiceEngine } from "@/lib/voice/tts.server";

const persona = { persona: DEFAULT_VOICE_PERSONA };

describe("VOICE NATURALNESS V2 — presentation layer", () => {
  it("1. strips markdown so headings and bullets are never read as a document", () => {
    const out = stripForSpeech("## Pakej Disember\n**Harga** _terbaik_\n- Madinah\n- Makkah");
    expect(out).not.toMatch(/[#*_-]/);
    expect(out).toContain("Pakej Disember");
  });

  it("2. strips URLs and email addresses", () => {
    const out = stripForSpeech("Lihat https://umraio.com/pakej atau emel sales@umraio.com ya.");
    expect(out).not.toContain("http");
    expect(out).not.toContain("@");
  });

  it("3. strips internal references, ids and worker names", () => {
    const out = stripForSpeech(
      "Rujukan IIL-MT5X9 (ruj: 9f1a) conversation_id 3f1c0f2e-1111-2222-3333-444455556666 oleh AI Sales Elite.",
    );
    expect(out).not.toMatch(/IIL-MT5X9|conversation_id|3f1c0f2e/i);
  });

  it("4. converts punctuation and lists into natural spoken structure", () => {
    const out = prepareSpokenResponse({
      replyText: "Pilihan pakej:\n- Ekonomi\n- Selesa\n- Premium",
      persona,
    }).spokenText;
    expect(out).toContain("dan");
    expect(out).not.toContain("\n");
    expect(out.endsWith(".")).toBe(true);
  });

  it("5. normalises Malay numbers exactly, never approximating", () => {
    expect(malayNumber(5990)).toBe("lima ribu sembilan ratus sembilan puluh");
    expect(malayNumber(11)).toBe("sebelas");
    expect(malayNumber(2026)).toBe("dua ribu dua puluh enam");
    expect(malayNumber(1_000_000_000)).toBeNull();
  });

  it("6. normalises dates naturally instead of reading digits", () => {
    expect(malayDate(23, 12, 2026)).toBe("dua puluh tiga Disember dua ribu dua puluh enam");
    const spoken = normaliseMalaySpeech("Berlepas 23/12/2026.");
    expect(spoken).toContain("dua puluh tiga Disember");
    expect(spoken).not.toContain("23/12/2026");
  });

  it("7. normalises currency without changing the value", () => {
    expect(malayCurrency("5,990")).toBe("lima ribu sembilan ratus sembilan puluh ringgit");
    expect(malayCurrency("1,500.50")).toBe("seribu lima ratus ringgit lima puluh sen");
    expect(normaliseMalaySpeech("Harga RM5,990 seorang.")).toContain(
      "lima ribu sembilan ratus sembilan puluh ringgit",
    );
    expect(normaliseMalaySpeech("Diskaun 10%.")).toContain("sepuluh peratus");
  });

  it("8. a short reply stays short and is classified correctly", () => {
    const p = prepareSpokenResponse({ replyText: "Boleh Datuk, saya semak sekarang.", persona });
    expect(p.lengthClass).toBe("short");
    expect(p.estimatedSeconds).toBeLessThanOrEqual(10);
  });

  it("9. a very long reply is not spoken — text only", () => {
    const decision = decideVoiceReply({
      inboundModality: "audio",
      replyText: "Butiran pakej. ".repeat(80),
      persona,
    });
    expect(decision.speak).toBe(false);
    expect(decision.speak === false && decision.reason).toBe("too_long");
  });

  it("10. does not repeat confirmation questions on every turn", () => {
    const out = prepareSpokenResponse({
      replyText:
        "Harga bermula RM5,990. Adakah Datuk mahu saya semak? Nak saya hantar butiran? Nak saya call Datuk?",
      persona,
    }).spokenText;
    expect((out.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("10b. a repeated opening honorific is dropped on the next turn", () => {
    const first = prepareSpokenResponse({ replyText: "Baik Datuk. Harga bermula lima ribu.", persona });
    expect(first.opening?.toLowerCase()).toContain("baik");
    const second = prepareSpokenResponse({
      replyText: "Baik Datuk. Ada tiga pilihan lagi.",
      persona,
      lastOpening: first.opening,
    });
    expect(second.spokenText.toLowerCase().startsWith("baik datuk")).toBe(false);
  });

  it("11. persona settings really change preparation and engine parameters", () => {
    const calm = prepareSpokenResponse({ replyText: "Harga bermula RM5,990.", persona: { persona: "calm" } });
    const confident = prepareSpokenResponse({
      replyText: "Harga bermula RM5,990.",
      persona: { persona: "confident" },
    });
    expect(calm.speed).toBeLessThan(confident.speed);
    expect(calm.instructions).not.toBe(confident.instructions);
    expect(paceToSpeed(0)).toBeGreaterThanOrEqual(0.25);
    expect(paceToSpeed(100)).toBeLessThanOrEqual(4);
    // Overrides are clamped and applied on top of the preset.
    const custom = resolvePersona({ persona: "calm", controls: { pace: 999, warmth: -20 } });
    expect(custom.controls.pace).toBe(100);
    expect(custom.controls.warmth).toBe(0);
    expect(resolvePersona({ persona: "nonsense" }).key).toBe(DEFAULT_VOICE_PERSONA);
    expect(VOICE_PERSONAS[DEFAULT_VOICE_PERSONA].key).toBe("premium_sales_executive");
  });

  it("12. unsupported engine parameters are declared, not faked", () => {
    expect(VOICE_CONTROL_SUPPORT.pace).toBe("engine");
    expect(VOICE_CONTROL_SUPPORT.naturalness).toBe("presentation");
    expect(UNSUPPORTED_ENGINE_CONTROLS).toContain("warmth");
    expect(UNSUPPORTED_ENGINE_CONTROLS).not.toContain("pace");
    // Engine-partial controls are still honoured as textual guidance.
    const instructions = buildVoiceInstructions(VOICE_PERSONAS.empathetic.controls);
    expect(instructions.toLowerCase()).toContain("warm");
    expect(VOICE_CONTROL_KEYS).toHaveLength(7);
  });

  it("13. an approved Islamic answer is spoken verbatim, never paraphrased", () => {
    const approved =
      "Menurut jumhur ulama, ibadah umrah adalah sunnah muakkadah. Wallahu a'lam.";
    const p = prepareSpokenResponse({ replyText: approved, persona, preserveVerbatim: true });
    expect(p.verbatim).toBe(true);
    expect(p.spokenText).toBe(approved);
    // The conversational rewrite would have replaced "adalah" — it must not here.
    expect(p.spokenText).toContain("adalah sunnah muakkadah");
  });

  it("14. a pending Islamic review never produces a spoken ruling", () => {
    const decision = decideVoiceReply({
      inboundModality: "audio",
      replyText: "Hukumnya harus.",
      persona,
      islamicReviewPending: true,
    });
    expect(decision.speak).toBe(false);
    expect(decision.speak === false && decision.reason).toBe("pending_islamic_review");
  });

  it("15. an engine failure is reported cleanly so the caller falls back to text", async () => {
    const result = await xiaozhiVoiceEngine.synthesize({ text: "apa-apa" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("unsupported_engine");
  });

  it("16. unusable audio is rejected before upload, leaving the text answer intact", () => {
    expect(isDeliverableAudio({ byteLength: 0 })).toBe(false);
    expect(isDeliverableAudio({ byteLength: 9 * 1024 * 1024 })).toBe(false);
    expect(isDeliverableAudio({ byteLength: 12_000 })).toBe(true);
  });

  it("17. text conversations never enter the voice path", () => {
    const decision = decideVoiceReply({
      inboundModality: "text",
      replyText: "Harga bermula RM5,990.",
      persona,
    });
    expect(decision.speak).toBe(false);
    expect(decision.speak === false && decision.reason).toBe("not_voice_turn");
  });

  it("18. inbound voice still produces a spoken reply with preserved meaning", () => {
    const decision = decideVoiceReply({
      inboundModality: "audio",
      replyText:
        "Baik Datuk. Untuk pakej Umrah Disember, terdapat beberapa pilihan. Harga bermula daripada RM5,990 seorang.",
      persona,
    });
    expect(decision.speak).toBe(true);
    if (!decision.speak) return;
    expect(decision.text).toContain("beberapa pilihan");
    expect(decision.text).toContain("lima ribu sembilan ratus sembilan puluh ringgit");
    expect(decision.text).not.toContain("RM5,990");
    expect(decision.presentation.personaKey).toBe("premium_sales_executive");
  });

  it("19. length classification matches the commercial voice targets", () => {
    expect(classifySpokenLength(6)).toBe("short");
    expect(classifySpokenLength(15)).toBe("normal");
    expect(classifySpokenLength(32)).toBe("detailed");
    expect(classifySpokenLength(55)).toBe("too_long");
  });

  it("20. the legacy toSpeakableText helper still sanitises for older callers", () => {
    expect(toSpeakableText("**Salam** https://x.com Datuk")).toBe("Salam Datuk.");
  });
});
