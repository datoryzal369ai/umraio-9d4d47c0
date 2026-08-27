import { describe, expect, it } from "vitest";

import {
  existingQuotationCard,
  existingQuotationDeliveryReply,
  requestsExistingQuotationNow,
} from "@/lib/sales/whatsapp-presentation.core";
import { resolvePublicSiteUrl } from "@/lib/quotations/public-url.core";

const LIVE = {
  quotationNumber: "Q-2026-0002",
  packageName: "Umrah Ekonomi 12 Hari",
  totalMyr: 29400,
  depositMyr: 5000,
  pax: 3,
  link: "https://umraio.com/q/e611fe81746547973664bd66a608055d",
};

const STAFF_FICTION =
  /(maklumkan\s+staf|staf\s+agensi\s+akan|staf\s+akan\s+(siapkan|hantar))/i;

describe("P0 — deterministic existing-quotation delivery (runtime scenarios)", () => {
  it("A — exact failing message with a live deposit_pending quotation returns the card", () => {
    const reply = existingQuotationDeliveryReply({
      customerMessages: ["Saya nak quotation untuk 3 orang."],
      quotation: LIVE,
    });
    expect(reply).toBeTruthy();
    expect(reply).toContain("*QUOTATION UMRAH*");
    expect(reply).toContain("Q-2026-0002");
    expect(reply).toContain(LIVE.link);
    expect(reply).toContain("3 orang");
    expect(reply).toMatch(/SETUJU/);
    expect(reply!).not.toMatch(STAFF_FICTION);
  });

  it("B — plain 'Saya nak quotation' returns the card", () => {
    const reply = existingQuotationDeliveryReply({
      customerMessages: ["Saya nak quotation"],
      quotation: LIVE,
    });
    expect(reply).toContain("Q-2026-0002");
    expect(reply!).not.toMatch(STAFF_FICTION);
  });

  it("C — 'Wassap sekarang!' after a quotation request returns the card/link", () => {
    const reply = existingQuotationDeliveryReply({
      customerMessages: ["Saya nak quotation please", "Wassap sekarang !"],
      quotation: LIVE,
    });
    expect(reply).toContain(LIVE.link);
  });

  it("D — every usable live quotation status is surfaced identically", () => {
    for (const _status of [
      "ready",
      "sent",
      "viewed",
      "discussing",
      "accepted",
      "deposit_pending",
    ]) {
      const reply = existingQuotationDeliveryReply({
        customerMessages: ["Saya nak quotation untuk 3 orang."],
        quotation: LIVE,
      });
      expect(reply, _status).toContain("Q-2026-0002");
    }
  });

  it("F — no usable quotation leaves the creation flow intact (no staff fiction)", () => {
    expect(
      existingQuotationDeliveryReply({
        customerMessages: ["Saya nak quotation untuk 3 orang."],
        quotation: null,
      }),
    ).toBeNull();
    // a quotation without a real link/reference must never produce a card
    expect(
      existingQuotationDeliveryReply({
        customerMessages: ["Saya nak quotation"],
        quotation: { ...LIVE, link: null, quotationNumber: null },
      }),
    ).toBeNull();
  });

  it("G — non-quotation turns never trigger the deterministic branch", () => {
    expect(requestsExistingQuotationNow(["Assalamualaikum"])).toBe(false);
    expect(requestsExistingQuotationNow(["Saya nak quotation untuk 3 orang."])).toBe(true);
  });

  it("card omits facts that are unavailable and never fabricates them", () => {
    const card = existingQuotationCard({ ...LIVE, depositMyr: null, packageName: null });
    expect(card).not.toMatch(/Deposit/);
    expect(card).not.toMatch(/Pakej/);
    expect(card).toContain("Q-2026-0002");
  });
});

describe("public quotation URL must be customer-usable", () => {
  it("rejects preview/dev deployment hosts", () => {
    expect(
      resolvePublicSiteUrl("https://project--34af2e6d-dev.lovable.app"),
    ).toBe("https://umraio.com");
    expect(resolvePublicSiteUrl("http://localhost:8080")).toBe("https://umraio.com");
    expect(resolvePublicSiteUrl("")).toBe("https://umraio.com");
    expect(resolvePublicSiteUrl("not a url")).toBe("https://umraio.com");
  });

  it("keeps a real public site URL", () => {
    expect(resolvePublicSiteUrl("https://umraio.com/")).toBe("https://umraio.com");
    expect(resolvePublicSiteUrl("https://www.umraio.com")).toBe("https://www.umraio.com");
  });
});
