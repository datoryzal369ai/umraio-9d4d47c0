import { describe, expect, it } from "vitest";
import {
  LIVE_CALL_UNAVAILABLE_MS,
  capabilityTruthInstructions,
  customerAskedAboutAiIdentity,
  customerAskedForLiveCall,
  VOICE_CAPABILITY_FALLBACK_MS,
  sanitizeCapabilityClaims,
} from "@/lib/sales/capability-truth.core";

const FORBIDDEN =
  /(tidak\s+boleh\s+bercakap|tak\s+boleh\s+bercakap|tidak\s+boleh\s+hantar\s+voice|hanya\s+boleh\s+balas\s+mesej\s+tulisan|only\s+reply\s+in\s+text|i\s*'?m\s+only\s+a\s+text)/i;

describe("capability truth — after a successful voice note", () => {
  const cases = [
    "Maaf Datuk, saya memang tidak boleh bercakap atau hantar voice note. Pakej Madinah bermula RM6,900 seorang.",
    "Saya hanya boleh balas mesej tulisan sahaja. Bila Datuk bercadang nak berangkat?",
    "Sorry, I can't send a voice note. The package starts at RM6,900.",
    "I'm only a text-based AI. Which month are you planning?",
  ];

  for (const raw of cases) {
    it(`removes the false denial: ${raw.slice(0, 40)}…`, () => {
      const out = sanitizeCapabilityClaims(raw, { voiceAvailable: true });
      expect(out).not.toMatch(FORBIDDEN);
      expect(out.length).toBeGreaterThan(0);
    });
  }

  it("keeps the useful part of the reply", () => {
    const out = sanitizeCapabilityClaims(
      "Saya tidak boleh hantar voice note. Pakej Madinah bermula RM6,900 seorang.",
      { voiceAvailable: true },
    );
    expect(out).toContain("RM6,900");
  });

  it("drops unnecessary AI self-reference in normal sales talk", () => {
    const out = sanitizeCapabilityClaims(
      "Saya ialah sistem AI daripada UMRAIO. Bulan berapa Datuk nak berangkat?",
      { voiceAvailable: true },
    );
    expect(out).not.toMatch(/sistem AI/i);
    expect(out).toContain("Bulan berapa");
  });

  it("keeps AI disclosure when the customer asked directly", () => {
    const out = sanitizeCapabilityClaims("Ya, saya ialah sistem AI UMRAIO.", {
      voiceAvailable: true,
      customerAskedIdentity: true,
    });
    expect(out).toMatch(/sistem AI/i);
  });
});

describe("live phone call", () => {
  it("detects a call request", () => {
    expect(customerAskedForLiveCall("Boleh call saya sekarang?")).toBe(true);
    expect(customerAskedForLiveCall("Boleh hantar voice note?")).toBe(false);
  });

  it("says only that phone calling is unavailable, never that voice notes are", () => {
    expect(LIVE_CALL_UNAVAILABLE_MS).toMatch(/panggilan telefon/i);
    expect(LIVE_CALL_UNAVAILABLE_MS).not.toMatch(/voice note|nota suara/i);
    expect(sanitizeCapabilityClaims(LIVE_CALL_UNAVAILABLE_MS, { voiceAvailable: true })).toBe(
      LIVE_CALL_UNAVAILABLE_MS,
    );
  });

  it("identity question detection", () => {
    expect(customerAskedAboutAiIdentity("Awak ni AI ke manusia?")).toBe(true);
    expect(customerAskedAboutAiIdentity("Berapa harga pakej?")).toBe(false);
  });
});

describe("prompt instructions", () => {
  it("states all three capability facts", () => {
    const joined = capabilityTruthInstructions({ voiceAvailable: true }).join(" ");
    expect(joined).toMatch(/text reply = available/i);
    expect(joined).toMatch(/voice-note reply = AVAILABLE/i);
    expect(joined).toMatch(/Live phone call = NOT available/i);
  });
});

describe("hard guarantees", () => {
  it("never returns a denial-only reply unchanged", () => {
    const raws = [
      "Maaf, saya tidak boleh hantar voice note.",
      "I'm only a text-based AI.",
      "Saya hanya boleh balas mesej tulisan.",
    ];
    for (const raw of raws) {
      const out = sanitizeCapabilityClaims(raw, { voiceAvailable: true });
      expect(out).not.toBe(raw);
      expect(out).toBe(VOICE_CAPABILITY_FALLBACK_MS);
      expect(out).not.toMatch(FORBIDDEN);
    }
  });

  it("enforces the live-call rule at runtime, not just in the prompt", () => {
    const out = sanitizeCapabilityClaims("Pakej Madinah bermula RM6,900 seorang.", {
      voiceAvailable: true,
      liveCallRequested: true,
    });
    expect(out).toContain("panggilan telefon");
    expect(out).toContain("WhatsApp");
    expect(out).toContain("RM6,900");
    expect(out).not.toMatch(FORBIDDEN);
  });

  it("does not duplicate the live-call notice when already present", () => {
    const out = sanitizeCapabilityClaims(LIVE_CALL_UNAVAILABLE_MS, {
      voiceAvailable: true,
      liveCallRequested: true,
    });
    expect(out.match(/panggilan telefon/gi)?.length).toBe(1);
  });
});
