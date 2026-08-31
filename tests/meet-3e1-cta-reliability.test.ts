/**
 * UMRAIO® STEP 3E.1 — LIVE CONVERSATION & CTA RELIABILITY HARDENING.
 *
 * Commercial intent (payment / price / subscribe / trial) must stop discovery,
 * route to real CTAs only, and never invent a payment mechanism.
 */

import { describe, expect, test } from "vitest";

import { analyzeMeetConversation } from "@/lib/meet/b2b-executive.core";
import { analyzeConversion } from "@/lib/meet/b2b-conversion.core";
import { buildClosingRead, closingInstruction, detectHighIntent } from "@/lib/meet/closing-engine.core";
import type { DemoMessage } from "@/lib/meet-executive.core";

const v = (content: string): DemoMessage => ({ role: "visitor", content });
const e = (content: string): DemoMessage => ({ role: "executive", content });

const BASE: DemoMessage[] = [
  v("Salam, saya Dato' Kiki dari Kiki Travel."),
  e("Waalaikumsalam Dato' Kiki. Berapa orang dalam team sales sekarang?"),
  v("4 orang, enquiry 200 sebulan tapi tak sempat follow up."),
  e("Faham Dato'. Follow-up lambat memang buat enquiry senyap."),
];

function read(extra: DemoMessage[]) {
  const messages = [...BASE, ...extra];
  const intel = analyzeMeetConversation(messages);
  const conversion = analyzeConversion(intel, messages);
  return buildClosingRead({ intel, conversion, messages });
}

describe("payment questions are a buying moment", () => {
  for (const q of [
    "Ok macam mana saya nak buat bayaran?",
    "Payment macam mana?",
    "Macam mana nak bayar?",
    "Cara pembayaran macam mana?",
    "How do I pay?",
  ]) {
    test(`"${q}" stops discovery and routes to a real CTA`, () => {
      const r = read([v(q)]);
      expect(r.paymentQuestion).toBe(true);
      expect(r.stopDiscovery).toBe(true);
      expect(["START_FREE_TRIAL", "TALK_TO_OUR_TEAM"]).toContain(r.cta);
      const instr = closingInstruction(r);
      expect(instr).toContain("PAYMENT PATH");
      expect(instr).toContain("NO in-chat payment");
      expect(instr).toContain("Choose a Plan");
    });
  }
});

describe("price questions stop discovery without inventing figures", () => {
  test("Berapa harga?", () => {
    const r = read([v("Berapa harga?")]);
    expect(r.priceQuestion).toBe(true);
    expect(r.stopDiscovery).toBe(true);
    // Step 3G.1 — canonical published pricing may be quoted, invention may not.
    expect(closingInstruction(r)).toContain("RM299/month");
    expect(closingInstruction(r)).toContain("Never invent discounts");
  });
});

describe("subscribe / trial intent unchanged", () => {
  test("subscribe", () => {
    expect(detectHighIntent(["Macam mana nak subscribe?"]).kind).toBe("SUBSCRIBE");
    expect(read([v("Okay saya nak subscribe.")]).readiness).toBe("READY_TO_SUBSCRIBE");
  });
  test("trial", () => {
    expect(read([v("Saya nak cuba dulu.")]).readiness).toBe("READY_TO_TRIAL");
    expect(read([v("Saya nak trial.")]).cta).toBe("START_FREE_TRIAL");
  });
});

describe("safety still outranks commercial intent", () => {
  test("opt-out blocks the close", () => {
    const messages = [...BASE, v("Stop, jangan hantar mesej lagi."), v("Macam mana nak bayar?")];
    const intel = analyzeMeetConversation(messages);
    const conversion = analyzeConversion(intel, messages);
    const r = buildClosingRead({ intel, conversion, messages });
    expect(r.readiness).toBe("BLOCKED");
  });
});
