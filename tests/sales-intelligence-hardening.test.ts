import { describe, expect, test } from "vitest";

import {
  buildConversationIntelligence,
  type IntelligenceInput,
} from "../src/lib/sales/conversation-intelligence.core";
import {
  classifyHotelMention,
  detectBookingIntent,
  detectBudget,
  detectFrustration,
  detectHumanRequest,
  detectOptOut,
  detectTravellerNeeds,
  maskNegatedSpans,
  normalizeMessage,
} from "../src/lib/sales/hardening.core";

const turn = (body: string, sender: "customer" | "ai" = "customer") => ({
  sender,
  body,
  created_at: new Date().toISOString(),
});

function intel(messages: string[], overrides: Partial<IntelligenceInput> = {}) {
  return buildConversationIntelligence({
    messages: messages.map((m, i) => (i % 2 === 0 ? turn(m) : turn(m, "customer"))),
    ...overrides,
  } as IntelligenceInput);
}

describe("Step 3.6 — opt-out / do-not-contact", () => {
  const optOuts = [
    "jangan whatsapp lagi",
    "Jangan hantar mesej lagi",
    "stop messaging me",
    "unsubscribe",
    "tak nak terima promosi",
    "please remove my number",
  ];

  for (const phrase of optOuts) {
    test(`detects opt-out: ${phrase}`, () => {
      expect(detectOptOut(phrase).optedOut).toBe(true);
    });
  }

  test("opt-out drives DO_NOT_CONTACT state and STOP action", () => {
    const result = intel(["Berapa harga pakej?", "jangan whatsapp lagi"]);
    expect(result.state).toBe("DO_NOT_CONTACT");
    expect(result.nextBestAction).toBe("STOP");
    expect(result.optOut).toBe(true);
  });

  test("'berminat' inside an opt-out sentence never reads as interest", () => {
    const result = intel(["saya tak berminat, jangan whatsapp lagi"]);
    expect(result.optOut).toBe(true);
    expect(result.buyingSignals).toHaveLength(0);
  });

  test("genuine interest is not an opt-out", () => {
    expect(detectOptOut("saya berminat nak booking").optedOut).toBe(false);
  });
});

describe("Step 3.6 — negation masking and intent collision", () => {
  test("masks negated positive intent", () => {
    expect(maskNegatedSpans("saya tak nak booking dulu")).not.toContain("booking");
  });

  test("positive booking intent survives", () => {
    expect(detectBookingIntent("macam mana nak booking?")).toBe(true);
    expect(detectBookingIntent("nak book pakej ni")).toBe(true);
  });

  test("negated booking intent is not a buying signal", () => {
    const result = intel(["tak nak booking lagi la"]);
    expect(result.buyingSignals).not.toContain("READY_TO_BOOK");
  });
});

describe("Step 3.6 — short forms and typos", () => {
  test("normalizes Malaysian WhatsApp short forms", () => {
    const n = normalizeMessage("brp harga utk 2org?");
    expect(n).toContain("berapa");
    expect(n).toContain("orang");
  });

  test("deposit typos are understood", () => {
    const result = intel(["brp depost?"]);
    expect(result.buyingSignals).toContain("ASKED_HOW_TO_PAY");
  });

  test("pax short form is captured", () => {
    expect(detectBudget("kami 4org").pax).toBe(4);
  });
});

describe("Step 3.6 — preference vs objection", () => {
  test("hotel proximity is a requirement, not an objection", () => {
    const mention = classifyHotelMention("nak hotel dekat dengan Masjidil Haram");
    expect(mention.preference).toBe(true);
    expect(mention.objection).toBe(false);
    const result = intel(["nak hotel dekat dengan Masjidil Haram"]);
    expect(result.objections).not.toContain("HOTEL");
    expect(result.hotelProximityPreference).toBe(true);
  });

  test("hotel rejection is still an objection", () => {
    expect(classifyHotelMention("hotel ni terlalu jauh, tak sesuai").objection).toBe(true);
  });
});

describe("Step 3.6 — traveller needs", () => {
  test("detects elderly and mobility needs", () => {
    const needs = detectTravellerNeeds("mak saya 70 tahun, susah nak jalan jauh");
    expect(needs).toContain("ELDERLY_TRAVELLER");
    expect(needs).toContain("MOBILITY_CONCERN");
  });

  test("needs persist on the intelligence object", () => {
    const result = intel(["ibu saya warga emas, guna wheelchair"]);
    expect(result.travellerNeeds).toContain("ELDERLY_TRAVELLER");
  });
});

describe("Step 3.6 — budget dimension", () => {
  test("total budget is not read as per person", () => {
    const b = detectBudget("bajet semua sekali RM20000 untuk 4 orang");
    expect(b.totalBudgetMyr).toBe(20000);
    expect(b.perPersonBudgetMyr).toBeNull();
  });

  test("per-person budget is read correctly", () => {
    const b = detectBudget("bajet RM6000 seorang");
    expect(b.perPersonBudgetMyr).toBe(6000);
  });
});

describe("Step 3.6 — frustration and repetition", () => {
  test("detects repetition complaint", () => {
    expect(detectFrustration("saya dah bagitau tadi la")).toContain("REPETITION_COMPLAINT");
  });

  test("repetition overrides clarifying questions", () => {
    const result = intel(["nak pergi bulan Mac", "saya dah cakap tadi bulan Mac"]);
    expect(result.nextBestAction).toBe("ANSWER_FROM_CONTEXT");
  });
});

describe("Step 3.6 — deterministic human handoff", () => {
  test("explicit human request is detected", () => {
    expect(detectHumanRequest("nak cakap dengan staff sebenar")).toBe(true);
    expect(detectHumanRequest("can i speak to a human")).toBe(true);
  });

  test("human request forces handoff state", () => {
    const result = intel(["nak cakap dengan orang sebenar"]);
    expect(result.state).toBe("HUMAN_HANDOFF");
    expect(result.humanRequested).toBe(true);
  });

  test("explicit human/staff targets still escalate", () => {
    for (const m of [
      "saya nak bercakap dengan manusia",
      "nak bercakap dengan staff",
      "nak bercakap dengan staf",
      "nak bercakap dengan ejen",
      "nak bercakap dengan admin",
      "nak bercakap dengan pegawai",
      "nak bercakap dengan customer service",
    ]) {
      expect(detectHumanRequest(m)).toBe(true);
    }
  });

  test("talking to RAIŌ itself is NOT a handoff", () => {
    for (const m of [
      "Nak bercakap dengan awak",
      "Nak cakap dengan awak",
      "Nak bercakap dengan RAIŌ",
      "boleh bercakap dengan awak?",
      "saya nak bercakap dengan awak",
      "Heloo",
      "berapa harga pakej umrah bulan disember untuk 2 orang?",
    ]) {
      expect(detectHumanRequest(m)).toBe(false);
    }
    const result = intel(["Nak bercakap dengan awak"]);
    expect(result.humanRequested).toBe(false);
    expect(result.state).not.toBe("HUMAN_HANDOFF");
  });
});

describe("Step 3.6 — objection lifecycle", () => {
  test("resolved objections stop blocking progression", () => {
    const result = intel([
      "mahal sangat la harga ni",
      "ok takpe, saya faham. boleh terima",
    ]);
    expect(result.objectionLifecycle.some((o) => o.status === "RESOLVED")).toBe(true);
    expect(result.activeObjections).not.toContain("PRICE");
  });
});

describe("Step 3.6 — recommendation override", () => {
  test("recommends a package when enough data exists", () => {
    const result = buildConversationIntelligence({
      messages: [turn("pakej mana you recommend untuk kami?")],
      lead: {
        fullName: "Aminah",
        pax: 4,
        preferredMonth: "Mac",
        budgetMyr: 7000,
        city: "Shah Alam",
      },
    } as IntelligenceInput);
    expect(result.nextBestAction).toBe("RECOMMEND_PACKAGE");
  });
});
