import { describe, expect, it } from "vitest";

import {
  detectRequestedPackage,
  packageIdentityMatches,
  packageMismatchInstruction,
  packageMismatchReply,
} from "@/lib/quotations/package-identity.core";
import { existingQuotationDeliveryReply } from "@/lib/sales/whatsapp-presentation.core";

const CATALOGUE = ["Umrah Ekonomi 12 Hari", "Umrah VIP 14 Hari", "Umrah Premium 12 Hari"];

const ECONOMY_QUOTE = {
  quotationNumber: "Q-2026-0002",
  packageName: "Umrah Ekonomi 12 Hari",
  totalMyr: 29400,
  pax: 3,
  link: "https://umraio.com/q/token",
};

const VIP_QUOTE = { ...ECONOMY_QUOTE, packageName: "Umrah VIP 14 Hari" };

describe("RED-2 package identity matching", () => {
  it("A. explicit VIP request vs Economy quotation is a mismatch", () => {
    const requested = detectRequestedPackage(["Umrah VIP untuk 3 orang"], CATALOGUE);
    expect(requested?.id).toBe("vip");
    expect(packageIdentityMatches(requested, ECONOMY_QUOTE.packageName)).toBe(false);
    const reply = packageMismatchReply(ECONOMY_QUOTE, requested!);
    expect(reply).toContain("*QUOTATION CHECK*");
    expect(reply).toContain("Q-2026-0002");
    expect(reply).toContain("bukan pakej");
    expect(reply).not.toMatch(/SETUJU/);
    expect(reply).not.toMatch(/staff/i);
  });

  it("B. VIP request with VIP quotation matches", () => {
    const requested = detectRequestedPackage(["Saya nak quotation VIP"], CATALOGUE);
    expect(packageIdentityMatches(requested, VIP_QUOTE.packageName)).toBe(true);
    expect(packageMismatchInstruction(VIP_QUOTE, requested)).toBeNull();
  });

  it("C. generic quotation request reuses existing quotation", () => {
    const messages = ["Saya nak quotation untuk 3 orang"];
    expect(detectRequestedPackage(messages, CATALOGUE)).toBeNull();
    expect(packageIdentityMatches(null, ECONOMY_QUOTE.packageName)).toBe(true);
    expect(
      existingQuotationDeliveryReply({ customerMessages: messages, quotation: ECONOMY_QUOTE }),
    ).toContain("Q-2026-0002");
  });

  it("D. VIP preference is sticky across a later generic ask", () => {
    const requested = detectRequestedPackage(
      ["Saya nak Umrah VIP", "Mana quotation?"],
      CATALOGUE,
    );
    expect(requested?.id).toBe("vip");
    expect(packageIdentityMatches(requested, ECONOMY_QUOTE.packageName)).toBe(false);
  });

  it("E. Economy request with Economy quotation matches", () => {
    const requested = detectRequestedPackage(["Saya nak pakej Ekonomi"], CATALOGUE);
    expect(packageIdentityMatches(requested, ECONOMY_QUOTE.packageName)).toBe(true);
  });

  it("F. catalogue names win over tier guesses and never leak other data", () => {
    const requested = detectRequestedPackage(["Nak Umrah Premium 12 Hari"], CATALOGUE);
    expect(requested?.fromCatalogue).toBe(true);
    expect(requested?.label).toBe("Umrah Premium 12 Hari");
    expect(packageIdentityMatches(requested, ECONOMY_QUOTE.packageName)).toBe(false);
  });

  it("G. no existing quotation leaves creation flow untouched", () => {
    expect(
      existingQuotationDeliveryReply({ customerMessages: ["Saya nak quotation"], quotation: null }),
    ).toBeNull();
    expect(packageMismatchInstruction(null, { id: "vip", label: "VIP", fromCatalogue: false })).toBeNull();
  });

  it("H. mismatch reply never fabricates requested-package pricing", () => {
    const requested = detectRequestedPackage(["Nak VIP"], CATALOGUE);
    const reply = packageMismatchReply(ECONOMY_QUOTE, requested!);
    const amounts = reply.match(/RM[\d,]+/g) ?? [];
    expect(amounts).toEqual(["RM29,400"]);
  });
});
