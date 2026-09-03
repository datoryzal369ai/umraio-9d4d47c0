import { describe, expect, it } from "vitest";

import {
  NEUTRAL_SIGNALS,
  adaptationInstruction,
  callerHasPendingWork,
  dominantSignals,
  readSignals,
  updateSignals,
} from "@/lib/calls/renagi-signals.core";
import { resolveCapabilities } from "@/lib/capabilities/registry.core";
import {
  LIVE_CALL_AVAILABLE_MS,
  LIVE_CALL_UNAVAILABLE_MS,
  capabilityTruthInstructions,
  sanitizeCapabilityClaims,
} from "@/lib/sales/capability-truth.core";

describe("rolling conversation signals", () => {
  it("starts neutral for an unknown blob", () => {
    expect(readSignals(null)).toEqual(NEUTRAL_SIGNALS);
    expect(readSignals({ interest: 5 }).interest).toBe(1);
  });

  it("raises price sensitivity from a real Malay utterance", () => {
    const next = updateSignals(NEUTRAL_SIGNALS, "Eh mahal sangat ni, ada diskaun tak?");
    expect(next.price_sensitivity).toBeGreaterThan(NEUTRAL_SIGNALS.price_sensitivity);
    expect(dominantSignals(next)).toContain("price_sensitivity");
  });

  it("detects frustration and instructs acknowledge-before-sell", () => {
    let s = updateSignals(NEUTRAL_SIGNALS, "Dah berapa kali saya tanya, lambat sangat");
    s = updateSignals(s, "Saya tak puas hati");
    const lines = adaptationInstruction(s).join(" ");
    expect(lines).toMatch(/frustration/i);
  });

  it("decays toward neutral when the topic moves on", () => {
    const hot = updateSignals(NEUTRAL_SIGNALS, "mahal mahal harga diskaun");
    let cooled = hot;
    for (let i = 0; i < 12; i += 1) cooled = updateSignals(cooled, "ok");
    expect(cooled.price_sensitivity).toBeLessThan(hot.price_sensitivity);
  });

  it("keeps decision readiness at least near buying intent", () => {
    const s = updateSignals(NEUTRAL_SIGNALS, "Saya nak book pakej ni, boleh bayar deposit?");
    expect(s.decision_readiness).toBeGreaterThanOrEqual(s.buying_intent - 0.1001);
  });

  it("never emits the internal codename in guidance", () => {
    const joined = adaptationInstruction(updateSignals(NEUTRAL_SIGNALS, "mahal")).join(" ");
    expect(joined.toLowerCase()).not.toContain("renagi");
  });

  it("blocks termination when the caller says kejap or has another question", () => {
    expect(callerHasPendingWork("kejap ya")).toBe(true);
    expect(callerHasPendingWork("satu lagi soalan")).toBe(true);
    expect(callerHasPendingWork("terima kasih")).toBe(false);
  });
});

describe("canonical capability registry", () => {
  it("reports calling available only when the media gateway is wired", () => {
    expect(resolveCapabilities({}).whatsappCalling).toBe(false);
    expect(
      resolveCapabilities({
        WHATSAPP_MEDIA_GATEWAY_URL: "https://gw.example",
        WHATSAPP_MEDIA_GATEWAY_SECRET: "s",
      }).whatsappCalling,
    ).toBe(true);
  });

  it("strips the false 'calls not available' claim when calling is live", () => {
    const out = sanitizeCapabilityClaims(
      "Buat masa ini panggilan telefon belum tersedia. Pakej Disember RM7,900.",
      { voiceAvailable: true, callingAvailable: true },
    );
    expect(out).not.toMatch(/belum tersedia/i);
    expect(out).toMatch(/RM7,900/);
  });

  it("answers truthfully when the caller asks for a call and calling is live", () => {
    const out = sanitizeCapabilityClaims("Baik.", {
      voiceAvailable: true,
      callingAvailable: true,
      liveCallRequested: true,
    });
    expect(out).toContain(LIVE_CALL_AVAILABLE_MS);
  });

  it("keeps the honest unavailable answer when calling is not deployed", () => {
    const out = sanitizeCapabilityClaims("Baik.", {
      voiceAvailable: true,
      callingAvailable: false,
      liveCallRequested: true,
    });
    expect(out).toContain(LIVE_CALL_UNAVAILABLE_MS);
  });

  it("tells the model calling is available in the prompt", () => {
    const joined = capabilityTruthInstructions({ voiceAvailable: true, callingAvailable: true }).join(" ");
    expect(joined).toMatch(/Live WhatsApp call = AVAILABLE/);
  });
});
