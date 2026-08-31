import { describe, expect, test } from "vitest";

import {
  canTransition,
  clampPilgrims,
  computeQuotation,
  quotationMessage,
} from "../src/lib/quotations/pricing.core";

describe("deterministic quotation pricing", () => {
  test("totals are computed from unit price and pilgrims", () => {
    const p = computeQuotation({ unitPrice: 8900, pilgrims: 3, deposit: { rule: "none" } });
    expect(p.subtotal).toBe(26700);
    expect(p.total).toBe(26700);
    expect(p.depositAmount).toBeNull();
  });

  test("percentage deposit and balance", () => {
    const p = computeQuotation({
      unitPrice: 10000,
      pilgrims: 2,
      deposit: { rule: "percent", percent: 15 },
    });
    expect(p.total).toBe(20000);
    expect(p.depositAmount).toBe(3000);
    expect(p.balanceAmount).toBe(17000);
  });

  test("fixed deposit never exceeds the total", () => {
    const p = computeQuotation({
      unitPrice: 500,
      pilgrims: 1,
      deposit: { rule: "fixed", fixedMyr: 1000 },
    });
    expect(p.depositAmount).toBe(500);
    expect(p.balanceAmount).toBe(0);
  });

  test("discount is clamped and never negative", () => {
    const p = computeQuotation({
      unitPrice: 1000,
      pilgrims: 1,
      discount: 5000,
      deposit: { rule: "none" },
    });
    expect(p.discount).toBe(1000);
    expect(p.total).toBe(0);
  });

  test("pilgrim count is bounded", () => {
    expect(clampPilgrims(0)).toBe(1);
    expect(clampPilgrims("4")).toBe(4);
    expect(clampPilgrims(9999)).toBe(200);
  });

  test("status machine only allows forward moves", () => {
    expect(canTransition("ready", "sent")).toBe(true);
    expect(canTransition("sent", "booked")).toBe(false);
    expect(canTransition("accepted", "deposit_pending")).toBe(true);
    expect(canTransition("booked", "cancelled")).toBe(false);
  });

  test("customer message contains only computed figures", () => {
    const pricing = computeQuotation({
      unitPrice: 7500,
      pilgrims: 2,
      deposit: { rule: "fixed", fixedMyr: 2000 },
    });
    const text = quotationMessage({
      quotationNumber: "Q-2026-0001",
      agencyName: "Test Travel",
      packageName: "Umrah Ramadan",
      pricing,
    });
    expect(text).toContain("RM 15,000");
    expect(text).toContain("RM 2,000");
    expect(text).toContain("Q-2026-0001");
  });
});
