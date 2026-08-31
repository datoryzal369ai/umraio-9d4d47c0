import { describe, expect, test } from "vitest";

import {
  buildBehavioralProfile,
  behavioralInstruction,
  behavioralFollowupHint,
} from "@/lib/sales/behavioral.core";
import { buildConversationIntelligence } from "@/lib/sales/conversation-intelligence.core";

const p = (...customerMessages: string[]) => buildBehavioralProfile({ customerMessages });

describe("Step 3.7 — behavioural signal model", () => {
  test("B1 exploration only → no fabricated readiness", () => {
    const b = p("Salam, nak tanya pasal pakej umrah");
    expect(b.decisionReadiness.value).toBe("EXPLORING");
    expect(b.strategy).toBe("UNDERSTAND_NEED");
    expect(b.priceSensitivity.value).toBe("UNKNOWN");
  });

  test("B2 interest + price concern → value clarification, never a discount", () => {
    const b = p("Saya suka package ni tapi mahal sikit");
    expect(b.priceSensitivity.value).toBe("HIGH");
    expect(b.strategy).toBe("VALUE_CLARIFICATION");
  });

  test("single price question is not price sensitivity", () => {
    const b = p("Berapa harga pakej umrah bulan Mac?");
    expect(b.priceSensitivity.value).toBe("LOW");
  });

  test("B3 trust concern → build trust", () => {
    const b = p("Agency ni selamat ke? Takut kena scam");
    expect(b.trust.value).toBe("LOW");
    expect(b.strategy).toBe("BUILD_TRUST");
  });

  test("B4 decision-maker dependency is a process, not a rejection", () => {
    const b = p("Saya kena bincang dengan suami dulu");
    expect(b.decisionMakerDependency).toBe(true);
    expect(b.decisionMakers).toContain("SPOUSE");
    expect(b.strategy).toBe("SUPPORT_DECISION_PROCESS");
  });

  test("B5 resolved dependency → facilitate booking", () => {
    const b = p("Saya kena bincang dengan suami dulu", "Dah bincang dengan suami, kami nak proceed");
    expect(b.decisionMakerDependency).toBe(false);
    expect(b.decisionMakerResolved).toBe(true);
    expect(b.strategy).toBe("FACILITATE_BOOKING");
  });

  test("B6 hesitation detected without being treated as rejection", () => {
    const b = p("Hmm nanti saya fikir dulu ya", "Tengok dulu, tak pasti lagi", "Belum decide");
    expect(b.hesitation.value).toBe("HIGH");
    expect(b.decisionReadiness.value).toBe("CONSIDERING");
  });

  test("B7 comparison behaviour is classified", () => {
    const b = p("Apa beza package A dengan package B? Hotel mana lagi dekat?");
    expect(b.comparison.length).toBeGreaterThan(0);
    expect(b.valueDimensions).toContain("DISTANCE");
  });

  test("B8 frustration → repair experience outranks selling", () => {
    const b = p("Dah tiga kali saya bagitahu, kenapa tanya lagi?");
    expect(b.strategy).toBe("REPAIR_EXPERIENCE");
  });

  test("B9 information overload → simplify", () => {
    const b = buildBehavioralProfile({
      customerMessages: ["Banyak sangat pilihan, yang mana satu paling sesuai?"],
    });
    expect(b.informationLoad).toBe("HIGH");
    expect(b.strategy).toBe("SIMPLIFY_CHOICES");
  });

  test("B10 explicit booking intent → facilitate booking", () => {
    const b = p("Okay saya nak booking. Macam mana?");
    expect(b.decisionReadiness.value).toBe("READY_TO_BOOK");
    expect(b.strategy).toBe("FACILITATE_BOOKING");
  });

  test("B11 deposit question with issued quotation → deposit ready", () => {
    const b = buildBehavioralProfile({
      customerMessages: ["Deposit berapa ya?"],
      quotationStatus: "sent",
    });
    expect(b.decisionReadiness.value).toBe("DEPOSIT_READY");
  });

  test("B12 opt-out overrides every behavioural strategy", () => {
    const b = p("Nak book", "Jangan whatsapp saya lagi");
    expect(b.strategy).toBe("STOP_CONTACT");
    expect(b.closingReadiness.value).toBe("UNKNOWN");
    expect(behavioralFollowupHint(b)).toBeNull();
  });

  test("B13 human request → human assist", () => {
    const b = p("Boleh cakap dengan orang sebenar tak?");
    expect(b.strategy).toBe("HUMAN_ASSIST");
  });

  test("B14 urgency is observed, never manufactured", () => {
    const b = p("Nak confirm cepat, tarikh dah dekat");
    expect(b.urgency.value === "MEDIUM" || b.urgency.value === "HIGH").toBe(true);
    expect(behavioralInstruction(b)).toContain("Never manufacture scarcity");
  });

  test("B15 communication behaviour is observed, not personality", () => {
    const b = p("nk tau brp harga", "ok", "boleh hantar?");
    expect(b.communicationTraits).toContain("CONCISE");
  });

  test("value dimensions drive what the reply leads with", () => {
    const b = p("Nak hotel dekat Haram, mak saya dah tua susah jalan jauh");
    expect(b.valueDimensions).toContain("DISTANCE");
    expect(b.valueDimensions).toContain("FAMILY_SUITABILITY");
  });
});

describe("Step 3.7 — integration with conversation intelligence", () => {
  const intel = (bodies: string[]) =>
    buildConversationIntelligence({
      messages: bodies.map((body) => ({ sender: "customer" as const, body, created_at: new Date().toISOString() })),
      lead: null,
      quotation: null,
    });

  test("behavioural profile is attached to conversation intelligence", () => {
    const i = intel(["Saya kena tanya isteri dulu"]);
    expect(i.behavior.decisionMakerDependency).toBe(true);
    expect(i.nextBestAction).toBe("SUPPORT_DECISION_MAKER");
  });

  test("safety still wins over behavioural overlay", () => {
    const i = intel(["Nak book", "Stop whatsapp saya"]);
    expect(i.nextBestAction).toBe("STOP");
    expect(i.behavior.strategy).toBe("STOP_CONTACT");
  });

  test("instruction block includes strategy guidance", () => {
    const i = intel(["Mahal sangat, ada yang murah sikit?"]);
    const text = behavioralInstruction(i.behavior);
    expect(text).toContain("Strategy:");
    expect(text).toContain("ETHICS:");
  });
});
