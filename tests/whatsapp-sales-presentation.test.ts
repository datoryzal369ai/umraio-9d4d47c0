import { describe, expect, it } from "vitest";

import {
  WHATSAPP_FORMAT_INSTRUCTION,
  QUOTATION_AUTONOMY_INSTRUCTION,
  HANDOVER_LANGUAGE_INSTRUCTION,
  NEXT_BEST_ACTION_INSTRUCTION,
  detectPriceIntent,
  directPriceInstruction,
  knownContextInstruction,
  pdfCapabilityInstruction,
  continueIntentInstruction,
  existingQuotationCard,
  existingQuotationDeliveryReply,
  existingQuotationInstruction,
  requestsExistingQuotationNow,
} from "@/lib/sales/whatsapp-presentation.core";

const PACKAGES = [
  { name: "Premium", price_myr: 6990, nights: 7 },
  { name: "Ekonomi", price_myr: 4990, nights: 7 },
];

describe("A — WhatsApp formatting contract", () => {
  it("requires short paragraphs, bold labels and bullets", () => {
    expect(WHATSAPP_FORMAT_INSTRUCTION).toMatch(/2-4 short paragraphs/);
    expect(WHATSAPP_FORMAT_INSTRUCTION).toMatch(/\*Harga\*/);
    expect(WHATSAPP_FORMAT_INSTRUCTION).toMatch(/•/);
    expect(WHATSAPP_FORMAT_INSTRUCTION).toMatch(/Never send a wall of text/);
  });
});

describe("B — direct answer to price intent", () => {
  it("detects price intent phrasings", () => {
    for (const m of ["Harga", "berapa", "berapa harga", "total berapa", "price", "berapa seorang"]) {
      expect(detectPriceIntent(m)).toBe(true);
    }
    expect(detectPriceIntent("Assalamualaikum")).toBe(false);
  });

  it("answers directly with per-pax and total, no clarification", () => {
    const out = directPriceInstruction({
      latestMessage: "Harga",
      packages: PACKAGES,
      pax: 3,
      packageInterest: "Premium",
    });
    expect(out).toBeTruthy();
    expect(out).toMatch(/ANSWER DIRECTLY NOW/);
    expect(out).toMatch(/RM6,990/);
    expect(out).toMatch(/RM20,970/);
    expect(out).toMatch(/Do not ask for it again/);
  });

  it("states the missing input only when no price is available", () => {
    const out = directPriceInstruction({ latestMessage: "harga", packages: [], pax: null });
    expect(out).toMatch(/no catalogue price/);
    expect(out).toMatch(/ONLY for that/);
  });

  it("stays silent when there is no price intent", () => {
    expect(
      directPriceInstruction({ latestMessage: "Terima kasih", packages: PACKAGES, pax: 3 }),
    ).toBeNull();
  });
});

describe("C — quotation autonomy", () => {
  it("requires executing the tool and explaining rejections truthfully", () => {
    expect(QUOTATION_AUTONOMY_INSTRUCTION).toMatch(/EXECUTE create_quotation/);
    expect(QUOTATION_AUTONOMY_INSTRUCTION).toMatch(/maklumkan staff/);
    expect(QUOTATION_AUTONOMY_INSTRUCTION).toMatch(/live quotation already exists/);
    expect(QUOTATION_AUTONOMY_INSTRUCTION).toMatch(/Never claim a new quotation was created/);
  });
});

describe("D — handover language + PDF truth", () => {
  it("blocks default staff deferral", () => {
    expect(HANDOVER_LANGUAGE_INSTRUCTION).toMatch(/not a default answer/);
  });

  it("answers PDF requests accurately without false staff claims", () => {
    const out = pdfCapabilityInstruction("Mana PDF?");
    expect(out).toMatch(/does not generate or send a PDF/);
    expect(out).toMatch(/customer link/);
    expect(out).toMatch(/never say staff will send it/i);
    expect(pdfCapabilityInstruction("Harga berapa?")).toBeNull();
  });
});

describe("E — conversational memory", () => {
  it("lists known facts as never-ask-again", () => {
    const out = knownContextInstruction({
      pax: 3,
      preferredMonth: "December",
      packageInterest: "VIP",
      city: null,
      fullName: null,
    });
    expect(out).toMatch(/NEVER ASK AGAIN/);
    expect(out).toMatch(/bilangan jemaah: 3/);
    expect(out).toMatch(/December/);
    expect(out).toMatch(/VIP/);
  });

  it("returns null when nothing is known", () => {
    expect(knownContextInstruction({})).toBeNull();
  });
});

describe("F — next best action and continuation", () => {
  it("enforces exactly one next action", () => {
    expect(NEXT_BEST_ACTION_INSTRUCTION).toMatch(/exactly ONE clear next action/);
  });

  it("executes on 'Teruskan' without restarting qualification", () => {
    const out = continueIntentInstruction("Teruskan");
    expect(out).toMatch(/execute the next available action/);
    expect(out).toMatch(/Do not restart qualification/);
    expect(continueIntentInstruction("Berapa harga?")).toBeNull();
  });
});

describe("G — existing live quotation surfacing", () => {
  const CARD = {
    quotationNumber: "Q-2026-0002",
    packageName: "Umrah VIP",
    totalMyr: 20970,
    depositMyr: 3000,
    pax: 3,
    link: "https://umraio.com/q/tok123",
  };

  it("renders a bolded, bulleted quotation card with the existing link", () => {
    const out = existingQuotationCard(CARD);
    expect(out).toMatch(/\*QUOTATION UMRAH\*/);
    expect(out).toMatch(/\*3 orang\*/);
    expect(out).toMatch(/• \*Pakej:\* Umrah VIP/);
    expect(out).toMatch(/• \*Jumlah:\* RM20,970/);
    expect(out).toMatch(/• \*Deposit:\* RM3,000/);
    expect(out).toMatch(/• \*Rujukan:\* Q-2026-0002/);
    expect(out).toContain("https://umraio.com/q/tok123");
    expect(out).toMatch(/balas \*SETUJU\*/);
    expect(out).not.toMatch(/staf|staff/i);
  });

  it("omits deposit when unavailable", () => {
    expect(existingQuotationCard({ ...CARD, depositMyr: null })).not.toMatch(/Deposit/);
  });

  it("instructs the model to surface it and forbids staff fiction", () => {
    const out = existingQuotationInstruction(CARD)!;
    expect(out).toMatch(/EXISTING LIVE QUOTATION/);
    expect(out).toMatch(/Do NOT call create_quotation/);
    expect(out).toMatch(/staff akan siapkan/);
    expect(out).toContain("Q-2026-0002");
  });

  it("stays silent when no quotation exists (new-quotation flow untouched)", () => {
    expect(existingQuotationInstruction(null)).toBeNull();
    expect(existingQuotationInstruction({ totalMyr: 100 })).toBeNull();
  });

  it("answers 'Mana PDF?' with the existing quotation link, never a staff promise", () => {
    const out = pdfCapabilityInstruction("Mana PDF?", CARD.link)!;
    expect(out).toMatch(/does not generate or send a PDF/);
    expect(out).toContain(CARD.link);
    expect(out).toMatch(/never say staff will send it/i);
  });

  it("A. 'Saya nak quotation' deterministically returns the card and URL", () => {
    const out = existingQuotationDeliveryReply({
      customerMessages: ["Saya nak quotation"],
      quotation: CARD,
    });
    expect(out).toBe(existingQuotationCard(CARD));
    expect(out).toContain(CARD.link);
    expect(out).toMatch(/\*Pakej:\* Umrah VIP/);
    expect(out).toMatch(/\*3 orang\*/);
    expect(out).not.toMatch(/staf|staff|email/i);
  });

  it("B. 'Wassap sekarang!' after quotation request returns the existing card", () => {
    const out = existingQuotationDeliveryReply({
      customerMessages: ["Saya nak quotation please", "Wassap sekarang!"],
      quotation: CARD,
    });
    expect(out).toBe(existingQuotationCard(CARD));
    expect(out).toContain(CARD.link);
    expect(out).not.toMatch(/staf|staff|akan maklumkan/i);
  });

  it("C. an equivalent ASR transcript follows the same semantic branch", () => {
    expect(requestsExistingQuotationNow(["saya nak quotation please"])).toBe(true);
    const out = existingQuotationDeliveryReply({
      customerMessages: ["saya nak quotation please"],
      quotation: CARD,
    });
    expect(out).toContain(CARD.link);
    expect(out).not.toMatch(/staf|staff/i);
  });

  it("D. no live quotation leaves the truthful missing-input/new quotation flow intact", () => {
    expect(
      existingQuotationDeliveryReply({
        customerMessages: ["Saya nak quotation"],
        quotation: null,
      }),
    ).toBeNull();
  });

  it("does not reinterpret unrelated 'WhatsApp now' text without quotation context", () => {
    expect(requestsExistingQuotationNow(["Wassap sekarang!"])).toBe(false);
  });
});
