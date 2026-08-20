import { describe, expect, it } from "vitest";

import { analyzeMeetConversation } from "@/lib/meet/b2b-executive.core";
import { analyzeConversion } from "@/lib/meet/b2b-conversion.core";
import {
  buildClosingRead,
  closingInstruction,
  ctaAlreadyPresented,
  detectHighIntent,
  detectPostCtaSignal,
} from "@/lib/meet/closing-engine.core";
import type { DemoMessage } from "@/lib/meet-executive.core";

function read(msgs: DemoMessage[]) {
  const intel = analyzeMeetConversation(msgs);
  const conversion = analyzeConversion(intel, msgs);
  return buildClosingRead({ intel, conversion, messages: msgs });
}

const v = (content: string): DemoMessage => ({ role: "visitor", content });
const e = (content: string): DemoMessage => ({ role: "executive", content });

describe("STEP 3F — high-intent detection", () => {
  const highIntent = [
    "Macam mana nak subscribe?",
    "Macam mana nak mula?",
    "Saya nak cuba.",
    "Boleh daftar?",
    "Okay, saya nak ambil.",
    "Boleh start sekarang?",
    "Where do I sign up?",
    "How do I subscribe?",
    "I want to get started.",
    "Can I start today?",
    "Okay, how to start?",
    "Can try first ah?",
    "Where to subscribe?",
  ];
  for (const line of highIntent) {
    it(`detects "${line}"`, () => {
      expect(detectHighIntent([line]).kind).not.toBeNull();
    });
  }

  it("does not treat curiosity as intent", () => {
    expect(detectHighIntent(["Apa benda UMRAIO ni?"]).kind).toBeNull();
  });
});

describe("STEP 3F — readiness ladder and CTA selection", () => {
  it("A. curious visitor keeps the conversation open", () => {
    const r = read([v("Salam, saya nak tahu pasal UMRAIO.")]);
    expect(r.readiness).toBe("EXPLORING");
    expect(r.cta).toBe("CONTINUE_CONVERSATION");
    expect(r.stopDiscovery).toBe(false);
  });

  it("C. price objection clarifies value instead of pushing subscription", () => {
    const r = read([
      v("Enquiry banyak tapi team tak sempat follow up."),
      e("Faham."),
      v("Mahal juga untuk agency kecil macam kami."),
    ]);
    expect(r.cta).not.toBe("START_FREE_TRIAL");
    expect(closingInstruction(r)).toContain("Never invent pricing");
  });

  it("F. partner decision produces a forwardable summary", () => {
    const r = read([
      v("Enquiry banyak tapi follow-up tak konsisten."),
      e("Faham."),
      v("Saya kena bincang dengan partner dulu."),
    ]);
    expect(r.readiness).toBe("DECISION_MAKER_DEPENDENT");
    expect(r.cta).toBe("FORWARDABLE_SUMMARY");
  });

  it("J/K/N/O/P. explicit subscription intent stops discovery and gives the real CTA", () => {
    for (const line of [
      "Okay, macam mana nak subscribe?",
      "I want to get started.",
      "Okay, how to start?",
      "Boleh start sekarang?",
    ]) {
      const r = read([v("Follow-up team saya lemah."), e("Faham."), v(line)]);
      expect(r.readiness).toBe("READY_TO_SUBSCRIBE");
      expect(r.cta).toBe("START_FREE_TRIAL");
      expect(r.stopDiscovery).toBe(true);
      expect(r.confirmUnderstanding).toBe(true);
      const text = closingInstruction(r);
      expect(text).toContain("STOP DISCOVERY");
      expect(text).toContain("Never invent pricing");
    }
  });

  it("L/M. safety gates outrank commercial intent", () => {
    const optOut = read([v("Stop, jangan hantar apa-apa lagi. Macam mana nak subscribe?")]);
    const human = read([v("Saya nak cakap dengan manusia.")]);
    expect([optOut.readiness, human.readiness]).toContain("BLOCKED");
    expect(human.cta).toBe("CONTINUE_CONVERSATION");
  });
});

describe("STEP 3F — post-CTA behaviour", () => {
  const withCta: DemoMessage[] = [
    v("Follow-up lemah."),
    e("Kalau nak teruskan, boleh tekan Choose a Plan di bawah."),
  ];

  it("detects that a CTA was already presented", () => {
    expect(ctaAlreadyPresented(withCta)).toBe(true);
    expect(ctaAlreadyPresented([v("hi")])).toBe(false);
  });

  it("H. 'send details' switches to a forwardable summary", () => {
    const r = read([...withCta, v("Send me the details.")]);
    expect(r.postCta).toBe("SEND_DETAILS");
    expect(r.cta).toBe("FORWARDABLE_SUMMARY");
  });

  it("I. 'saya fikir dulu' stops selling", () => {
    const r = read([...withCta, v("Saya fikir dulu.")]);
    expect(r.readiness).toBe("HESITANT");
    expect(r.cta).toBe("CONTINUE_CONVERSATION");
    expect(closingInstruction(r)).toContain("no pressure");
  });

  it("respects 'nanti dulu' and plain agreement", () => {
    expect(detectPostCtaSignal("Nanti dulu")).toBe("DEFER");
    expect(detectPostCtaSignal("Okay.")).toBe("ACCEPT");
    expect(detectPostCtaSignal("Berapa lama nak setup?")).toBe("QUESTION");
  });

  it("does not re-pitch once the CTA is on the table", () => {
    const r = read([...withCta, v("Berapa lama nak setup?")]);
    expect(closingInstruction(r)).toContain("already been presented");
  });
});

describe("STEP 3F — full conversion journey", () => {
  it("reaches the real CTA without repeating discovery", () => {
    const journey: DemoMessage[] = [
      v("Salam"),
      e("Waalaikumsalam. Saya RAIŌ — Autonomous AI Business Executive™ daripada UMRAIO. Boleh saya tahu dengan siapa saya bercakap?"),
      v("Nama saya Rizal, saya owner agency Umrah."),
      e("Baik Rizal."),
      v("Sales saya slow."),
      e("Boleh cerita sikit macam mana enquiry masuk sekarang?"),
      v("Banyak enquiry masuk WhatsApp tapi team tak sempat follow-up."),
      e("Jadi bahagian follow-up tu memang manual."),
      v("Saya dah ada CRM."),
      e("Faham."),
      v("Mahal juga."),
      e("Faham."),
      v("Saya kena bincang dengan partner."),
      e("Boleh, saya ringkaskan."),
      v("Data customer saya selamat ke?"),
      e("Setakat yang saya boleh sahkan..."),
      v("Okay, macam mana nak subscribe?"),
    ];
    const r = read(journey);
    expect(r.readiness).toBe("READY_TO_SUBSCRIBE");
    expect(r.cta).toBe("START_FREE_TRIAL");
    expect(r.stopDiscovery).toBe(true);
    const text = closingInstruction(r);
    expect(text).toContain("Choose a Plan");
    expect(text).toContain("Talk to our team");
    expect(text).not.toMatch(/buying intent score|readiness score/i);
  });
});
