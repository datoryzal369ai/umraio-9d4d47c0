import { describe, expect, it } from "vitest";

import { classifyCustomerCarePolicy } from "../policy.core";

describe("UMRAIO autonomous customer-care policy", () => {
  it("allows routine customer care", () => {
    expect(classifyCustomerCarePolicy("Boleh bagi itinerary saya?")).toMatchObject({
      decision: "AUTO_ALLOWED",
      category: "routine",
    });
  });

  it("holds refunds for human approval", () => {
    expect(classifyCustomerCarePolicy("Saya mahu refund penuh")).toMatchObject({
      decision: "APPROVAL_REQUIRED",
      category: "billing",
    });
  });

  it("holds booking cancellation for approval", () => {
    expect(classifyCustomerCarePolicy("Tolong batalkan tempahan saya")).toMatchObject({
      decision: "APPROVAL_REQUIRED",
      category: "booking",
    });
  });

  it("hands over when a human is explicitly requested", () => {
    expect(classifyCustomerCarePolicy("Saya nak cakap dengan staf")).toMatchObject({
      decision: "HUMAN_HANDOFF",
    });
  });
});
