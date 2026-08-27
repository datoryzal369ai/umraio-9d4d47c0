import { describe, expect, it } from "vitest";

import {
  closingIntentDetected,
  detectQuotationAcceptance,
  missingQuotationInputInstruction,
  missingQuotationInputs,
} from "../src/lib/quotations/closing.core";

describe("AI Quotation Executive — missing input", () => {
  it("detects closing intent from a quotation request", () => {
    expect(closingIntentDetected("boleh bagi sebut harga?")).toBe(true);
    expect(closingIntentDetected("hotel dekat tak dengan masjid?")).toBe(false);
  });

  it("reports package and pax as missing when the lead has neither", () => {
    expect(missingQuotationInputs({ latestMessage: "nak quotation" })).toEqual(["package", "pax"]);
  });

  it("treats stated pax in the message as known", () => {
    expect(missingQuotationInputs({ latestMessage: "nak quotation untuk 4 orang" })).toEqual([
      "package",
    ]);
  });

  it("emits a one-question directive when closing intent lacks inputs", () => {
    const instruction = missingQuotationInputInstruction({
      latestMessage: "saya nak booking",
      packageInterest: null,
      pax: null,
    });
    expect(instruction).toContain("QUOTATION BLOCKED");
    expect(instruction).toContain("which package");
  });

  it("stays silent when everything needed is known", () => {
    expect(
      missingQuotationInputInstruction({
        latestMessage: "saya nak booking",
        packageInterest: "Umrah Premium 12H",
        pax: 3,
      }),
    ).toBeNull();
  });
});

describe("AI Quotation Executive — in-chat acceptance", () => {
  it("accepts explicit confirmations", () => {
    for (const text of ["Saya setuju", "ok saya nak proceed", "Teruskan", "confirm", "Deal"]) {
      expect(detectQuotationAcceptance(text)).toBe(true);
    }
  });

  it("never treats a bare 'boleh' or a question as acceptance", () => {
    for (const text of ["boleh", "boleh tengok pakej lain?", "ok", ""]) {
      expect(detectQuotationAcceptance(text)).toBe(false);
    }
  });

  it("rejects deferrals and cancellations", () => {
    for (const text of ["tak jadi dulu", "fikir dulu ya", "cancel booking", "not now"]) {
      expect(detectQuotationAcceptance(text)).toBe(false);
    }
  });
});
