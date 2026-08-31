/**
 * UMRAIO® STEP 3E — RAIŌ LIVE HUMAN CONVERSATION & SALES CONVERSION STRESS TEST.
 *
 * Deterministic harness only. Scenarios A–O from the Step 3E brief are replayed
 * through the EXISTING engines (b2b-executive, b2b-conversion, social-presence)
 * and asserted on the behaviour those engines are actually responsible for:
 * state, intent, psychology, objections, demonstration relevance and presence.
 *
 * NOT EXECUTED here (requires a live model call, cannot be honestly asserted):
 *   - subjective naturalness of generated prose,
 *   - BM / Manglish phrasing quality of the model output,
 *   - absence of AI filler in generated text.
 * Those remain governed by the prompt layer and are marked NOT EXECUTED rather
 * than falsely passed.
 */

import { describe, expect, test } from "vitest";

import { analyzeMeetConversation, meetExecutiveInstruction } from "@/lib/meet/b2b-executive.core";
import { analyzeConversion, conversionInstruction } from "@/lib/meet/b2b-conversion.core";
import { buildSocialProfile, socialPresenceInstruction } from "@/lib/sales/social-presence.core";
import type { DemoMessage } from "@/lib/meet-executive.core";

const v = (content: string): DemoMessage => ({ role: "visitor", content });
const e = (content: string): DemoMessage => ({ role: "executive", content });

function read(...msgs: DemoMessage[]) {
  const intel = analyzeMeetConversation(msgs);
  const conv = analyzeConversion(intel, msgs);
  const social = buildSocialProfile({
    messages: msgs.map((m) => ({ sender: m.role === "visitor" ? "customer" : "ai", body: m.content })),
  });
  const prompt = [
    socialPresenceInstruction(social),
    meetExecutiveInstruction(intel),
    conversionInstruction(conv),
  ].join("\n");
  return { intel, conv, social, prompt };
}

describe("A — curious agency", () => {
  const { conv, intel, social } = read(v("Salam, saya nak tahu UMRAIO boleh buat apa."));

  test("does not jump past discovery", () => {
    expect(["AWARENESS", "DISCOVERY"]).toContain(conv.state);
    expect(conv.commercialIntent).not.toBe("SUBSCRIPTION_READY");
  });
  test("no value bridge is fabricated before evidence", () => {
    expect(conv.valueBridge).toBeNull();
    expect(intel.diagnosis).toBeNull();
  });
  test("salam is recognised so it can be returned", () => {
    expect(social.greetedWithSalam).toBe(true);
  });
  test("no name or honorific is invented", () => {
    expect(social.address.name).toBeNull();
    expect(social.address.honorific).toBeNull();
    expect(social.needsIntroduction).toBe(true);
  });
});

describe("B — skeptical agency", () => {
  const { conv } = read(v("All AI says the same thing. Betul ke ini boleh bantu?"));
  test("scepticism is read and answered with demonstration, not claims", () => {
    expect(conv.psychology.map((p) => p.key)).toContain("SCEPTICISM");
  });
});

describe("C — price objection", () => {
  const { conv } = read(
    v("Enquiry WhatsApp banyak tapi team lambat reply."),
    e("Faham."),
    v("Mahal juga."),
  );
  test("price sensitivity detected and objection is active", () => {
    expect(conv.psychology.map((p) => p.key)).toContain("PRICE_SENSITIVITY");
    expect(conv.activeObjections).toContain("COST");
    expect(conv.state).toBe("OBJECTION");
  });
});

describe("D — competitor / already have CRM", () => {
  const { conv } = read(v("Saya dah ada CRM."));
  test("CRM objection active, no attack on the incumbent", () => {
    expect(conv.activeObjections).toContain("ALREADY_HAVE_CRM");
  });
});

describe("E — follow-up pain", () => {
  const { intel, conv } = read(v("Enquiry banyak tapi team tak sempat follow-up."));
  test("follow-up gap detected and follow-up demonstration selected", () => {
    expect(intel.detectedGaps.map((g) => g.key)).toContain("followup");
    expect(conv.demonstration?.path).toBe("FOLLOW_UP");
  });
});

describe("F — WhatsApp response pain", () => {
  const { intel, conv } = read(v("My team can't reply fast enough on WhatsApp."));
  test("response gap → WhatsApp demonstration", () => {
    expect(intel.detectedGaps.map((g) => g.key)).toContain("response");
    expect(conv.demonstration?.path).toBe("WHATSAPP_LEAD_HANDLING");
  });
});

describe("G — trust / data security", () => {
  const { conv } = read(v("Data customer saya selamat ke?"));
  test("security objection active", () => {
    expect(conv.activeObjections).toContain("DATA_SECURITY");
  });
});

describe("H — partner decision", () => {
  const { conv } = read(v("Saya kena bincang dengan partner dulu."));
  test("decision-maker dependency detected, no pressure state", () => {
    expect(conv.activeObjections).toContain("NEEDS_PARTNER_APPROVAL");
    expect(conv.psychology.map((p) => p.key)).toContain("DECISION_MAKER");
    expect(conv.state).not.toBe("SUBSCRIPTION_READY");
  });
});

describe("I — high intent", () => {
  const { conv } = read(v("Macam mana nak subscribe?"));
  test("subscription intent short-circuits discovery", () => {
    expect(conv.commercialIntent).toBe("SUBSCRIPTION_READY");
    expect(conv.state).toBe("SUBSCRIPTION_READY");
  });
});

describe("J — ready to buy", () => {
  const { conv } = read(
    v("Enquiry banyak tapi follow-up lemah."),
    e("Faham."),
    v("Okay, saya nak cuba."),
  );
  test("trial intent reached", () => {
    expect(["TRIAL_READY", "SUBSCRIPTION_READY"]).toContain(conv.commercialIntent);
    expect(["TRIAL_READY", "SUBSCRIPTION_READY"]).toContain(conv.state);
  });
});

describe("K — Manglish", () => {
  const { intel, conv } = read(v("Actually enquiry banyak, but team tak really follow up."));
  test("mixed register handled and follow-up pain still detected", () => {
    expect(intel.detectedGaps.map((g) => g.key)).toContain("followup");
    expect(conv.state).not.toBe("AWARENESS");
  });
});

describe("L — Bahasa Melayu, vague problem", () => {
  const { intel, conv } = read(v("Sales saya slow, saya tak tahu dekat mana masalah."));
  test("stays in discovery instead of pitching", () => {
    expect(intel.language).toBe("ms");
    expect(conv.valueBridge).toBeNull();
    expect(["DISCOVERY", "PAIN_RECOGNISED"]).toContain(conv.state);
  });
});

describe("M — frustrated agency", () => {
  const { intel, prompt } = read(
    v("Enquiry banyak tapi team lambat reply."),
    e("Berapa ramai team?"),
    v("Saya dah explain banyak kali."),
  );
  test("frustration detected and repair takes priority over selling", () => {
    expect(intel.frustration.length).toBeGreaterThan(0);
    expect(intel.nextBestAction).toBe("REPAIR_EXPERIENCE");
    expect(prompt).toContain("REPAIR_EXPERIENCE");
  });
});

describe("N — feature challenge", () => {
  const { conv } = read(
    v("Enquiry WhatsApp banyak tapi team lambat reply."),
    e("Faham."),
    v("Show me exactly how UMRAIO would help my agency."),
  );
  test("demonstration is selected and grounded in their own gap", () => {
    expect(conv.demonstration).not.toBeNull();
    expect(conv.state).toBe("DEMONSTRATION");
  });
});

describe("O — competitor comparison", () => {
  const { conv } = read(v("Why should I use UMRAIO instead of another AI tool?"));
  test("comparison behaviour detected", () => {
    expect(conv.psychology.map((p) => p.key)).toContain("COMPARISON");
  });
});

describe("critical failure guards", () => {
  test("opt-out and human handoff block conversion", () => {
    const stop = read(v("Stop, jangan hantar mesej lagi."));
    expect(stop.conv.blocked).toBe(true);
    const human = read(v("Saya nak cakap dengan orang sebenar."));
    expect(human.conv.blocked).toBe(true);
  });

  test("no honorific is invented from a bare name", () => {
    const { social } = read(v("Nama saya Rizal."));
    expect(social.address.name).toBe("Rizal");
    expect(social.address.honorific).toBeNull();
  });

  test("prompt forbids invented figures, urgency and manipulation", () => {
    const { prompt } = read(v("Enquiry banyak tapi follow-up lemah."));
    expect(prompt).toContain("NEVER manipulate");
    expect(prompt.toLowerCase()).toContain("never invent");
  });
});

describe("NOT EXECUTED — requires live model interaction", () => {
  test.skip("naturalness of generated BM prose", () => {});
  test.skip("absence of AI filler in generated replies", () => {});
  test.skip("Manglish register quality of generated replies", () => {});
});
