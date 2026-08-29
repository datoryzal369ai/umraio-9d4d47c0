/**
 * Y-2 FIX — SETUJU on an already-accepted quotation must still resolve a
 * server-derived deposit and reach the Stripe checkout creation path.
 */
import { describe, expect, it } from "vitest";

import {
  PLATFORM_DEFAULT_DEPOSIT_PERCENT,
  resolveDepositMyr,
} from "@/lib/bookings/deposit.core";
import { findResumableAcceptedQuotation } from "@/lib/quotations/acceptance.server";
import { quotationAcceptedReply } from "@/lib/quotations/closing.core";

const AGENCY = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";
const CONV = "33333333-3333-3333-3333-333333333333";

function makeDb(rows: Array<Record<string, unknown>>) {
  const builder = () => {
    const state = { rows };
    const api: Record<string, unknown> = {};
    const chain = () => api;
    for (const k of ["select", "eq", "or", "in", "order", "limit"]) api[k] = chain;
    (api as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: state.rows, error: null });
    return api;
  };
  return { from: () => builder() } as never;
}

describe("Y-2 deposit resume", () => {
  it("derives a deposit from the platform default when the agency has no rule", () => {
    expect(resolveDepositMyr({ totalMyr: 29400, rule: "none" })).toBe(
      (29400 * PLATFORM_DEFAULT_DEPOSIT_PERCENT) / 100,
    );
  });

  it("honours an agency percent rule over the default", () => {
    expect(resolveDepositMyr({ totalMyr: 10000, rule: "percent", percent: 30 })).toBe(3000);
  });

  it("honours a fixed rule and never exceeds the total", () => {
    expect(resolveDepositMyr({ totalMyr: 1000, rule: "fixed", fixedMyr: 5000 })).toBe(1000);
  });

  it("returns null when there is no payable total", () => {
    expect(resolveDepositMyr({ totalMyr: 0, rule: "percent", percent: 20 })).toBeNull();
  });

  it("finds an already-accepted quotation so the payment link can be resent", async () => {
    const db = makeDb([
      {
        id: "q1",
        agency_id: AGENCY,
        lead_id: LEAD,
        conversation_id: CONV,
        status: "accepted",
        quotation_number: "Q-2026-0002",
        total: 29400,
        deposit_amount: null,
      },
    ]);
    const found = await findResumableAcceptedQuotation(db, {
      agencyId: AGENCY,
      leadId: LEAD,
      conversationId: CONV,
    });
    expect(found?.id).toBe("q1");
    expect(found?.totalMyr).toBe(29400);
  });

  it("never resumes another tenant's quotation", async () => {
    const db = makeDb([
      {
        id: "q2",
        agency_id: "other",
        lead_id: LEAD,
        conversation_id: CONV,
        status: "accepted",
        total: 100,
      },
    ]);
    expect(
      await findResumableAcceptedQuotation(db, {
        agencyId: AGENCY,
        leadId: LEAD,
        conversationId: CONV,
      }),
    ).toBeNull();
  });

  it("drops the 'agency will follow up' line when a payment link follows", () => {
    const withLink = quotationAcceptedReply({
      quotationNumber: "Q-2026-0002",
      totalMyr: 29400,
      depositMyr: 5880,
      depositLinkFollows: true,
    });
    expect(withLink).not.toMatch(/tetapan agensi/i);
    expect(withLink).toContain("RM5,880");
    expect(
      quotationAcceptedReply({ quotationNumber: "Q", totalMyr: 100, depositMyr: 20 }),
    ).toMatch(/tetapan agensi/i);
  });
});
