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
      latestMessage: "saya nak tempah",
      packageInterest: null,
      pax: null,
    });
    expect(instruction).toContain("QUOTATION BLOCKED");
    expect(instruction).toContain("which package");
  });

  it("stays silent when everything needed is known", () => {
    expect(
      missingQuotationInputInstruction({
        latestMessage: "saya nak tempah",
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

  it("E. preserves SETUJU acceptance after a quotation card", () => {
    expect(detectQuotationAcceptance("SETUJU")).toBe(true);

    const fs = require("node:fs") as typeof import("node:fs");
    const webhook = fs.readFileSync("src/routes/api/public/whatsapp.ts", "utf8");
    expect(webhook).toContain("detectQuotationAcceptance(latestBody)");
    expect(webhook).toContain('.update({ status: "accepted", accepted_at: acceptedAt })');
    expect(webhook).toContain('stage: "quotation_accepted"');
  });

  it("keeps deposit-pending quotations visible without changing the one-live rule", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const salesAi = fs.readFileSync("src/lib/sales-ai.server.ts", "utf8");
    expect(salesAi).toContain(
      '.in("status", ["ready", "sent", "viewed", "discussing", "accepted", "deposit_pending"])',
    );
    expect(salesAi).toContain('.in("status", ["ready", "sent", "viewed", "discussing"])');
  });

  it("I. preserves agency and lead isolation on the live quotation lookup", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const salesAi = fs.readFileSync("src/lib/sales-ai.server.ts", "utf8");
    const lookup = salesAi.slice(
      salesAi.indexOf("// Step 3: the live quotation"),
      salesAi.indexOf("return {", salesAi.indexOf("// Step 3: the live quotation")),
    );
    expect(lookup).toContain('.eq("agency_id", conversation.agency_id)');
    expect(lookup).toContain('.eq("lead_id", conversation.lead_id)');
  });
});
