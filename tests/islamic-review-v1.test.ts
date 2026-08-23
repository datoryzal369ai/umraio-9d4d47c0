import { describe, expect, it } from "vitest";

import {
  ISLAMIC_HOLDING_MESSAGE,
  ISLAMIC_PENDING_ACK_MESSAGE,
  canDecideIslamicReview,
  canTransition,
  islamicDedupeKey,
  isOpenIslamicReview,
  nextStatusFor,
  planPendingReviewReply,
  rejectionMessage,
  validateDecision,
} from "@/lib/islamic/review.core";

describe("Islamic Implementation Layer™ — review state machine", () => {
  it("1. a religious question produces one deterministic review key", () => {
    expect(islamicDedupeKey("ritual", "Boleh tak saya qasar solat?")).toBe(
      "ritual:boleh tak saya qasar solat",
    );
  });

  it("2. a re-phrased duplicate maps to the same dedupe key", () => {
    const a = islamicDedupeKey("ritual", "Boleh tak saya qasar solat?");
    const b = islamicDedupeKey("RITUAL", "  boleh  tak saya QASAR solat!!  ");
    expect(a).toBe(b);
  });

  it("3. a pending review breaks the clarification loop", () => {
    const plan = planPendingReviewReply({ status: "PENDING", holding_sent_at: null });
    expect(plan.kind).toBe("holding");
    expect(ISLAMIC_HOLDING_MESSAGE).not.toMatch(/betul\?/i);
  });

  it("4. only ONE holding response is produced per review", () => {
    const first = planPendingReviewReply({ status: "PENDING", holding_sent_at: null });
    const second = planPendingReviewReply({
      status: "PENDING",
      holding_sent_at: new Date().toISOString(),
    });
    expect(first.kind).toBe("holding");
    expect(second.kind).toBe("acknowledge");
    expect(second.kind === "acknowledge" && second.message).toBe(ISLAMIC_PENDING_ACK_MESSAGE);
  });

  it("5. an unauthorised user cannot approve", () => {
    expect(canDecideIslamicReview(["agent"])).toBe(false);
    expect(canDecideIslamicReview([])).toBe(false);
    expect(canDecideIslamicReview(null)).toBe(false);
  });

  it("6. an authorised Islamic approver can approve", () => {
    expect(canDecideIslamicReview(["islamic_approver"])).toBe(true);
    expect(canDecideIslamicReview(["owner"])).toBe(true);
    expect(canDecideIslamicReview(["admin"])).toBe(true);
  });

  it("7. approving requires a non-empty answer", () => {
    expect(
      validateDecision({ currentStatus: "PENDING", decision: "approve", approvedAnswer: "  " }).ok,
    ).toBe(false);
    expect(
      validateDecision({ currentStatus: "PENDING", decision: "approve", approvedAnswer: "Boleh." })
        .ok,
    ).toBe(true);
  });

  it("8. amending requires an amended answer", () => {
    expect(validateDecision({ currentStatus: "PENDING", decision: "amend" }).ok).toBe(false);
    expect(
      validateDecision({ currentStatus: "PENDING", decision: "amend", amendmentNotes: "Edited" })
        .ok,
    ).toBe(true);
  });

  it("9. rejecting requires a reason", () => {
    expect(validateDecision({ currentStatus: "PENDING", decision: "reject" }).ok).toBe(false);
    expect(
      validateDecision({
        currentStatus: "PENDING",
        decision: "reject",
        rejectionReason: "Not verifiable",
      }).ok,
    ).toBe(true);
  });

  it("10. invalid status transitions are rejected", () => {
    expect(canTransition("APPROVED", "REJECTED")).toBe(false);
    expect(canTransition("REJECTED", "APPROVED")).toBe(false);
    expect(canTransition("APPROVED", "APPROVED")).toBe(false);
    expect(
      validateDecision({
        currentStatus: "APPROVED",
        decision: "approve",
        approvedAnswer: "again",
      }).ok,
    ).toBe(false);
  });

  it("11. an amended review still requires final approval", () => {
    expect(canTransition("AMENDED", "APPROVED")).toBe(true);
    expect(canTransition("AMENDED", "REJECTED")).toBe(true);
    expect(canTransition("AMENDED", "AMENDED")).toBe(false);
    // AMENDED remains an OPEN review, so the loop breaker stays engaged.
    expect(isOpenIslamicReview("AMENDED")).toBe(true);
  });

  it("12. a rejected review never invents a religious answer", () => {
    const msg = rejectionMessage();
    expect(msg).toMatch(/tidak akan memberi hukum/i);
    expect(msg).not.toMatch(/harus|wajib|halal|haram/i);
  });

  it("13. decided reviews are closed and no longer block the conversation", () => {
    expect(isOpenIslamicReview("APPROVED")).toBe(false);
    expect(isOpenIslamicReview("REJECTED")).toBe(false);
    expect(planPendingReviewReply({ status: "APPROVED", holding_sent_at: null }).kind).toBe("none");
  });

  it("14. normal non-religious conversations are untouched (no open review)", () => {
    expect(planPendingReviewReply(null).kind).toBe("none");
  });

  it("15. decisions map to exactly one target status", () => {
    expect(nextStatusFor("approve")).toBe("APPROVED");
    expect(nextStatusFor("amend")).toBe("AMENDED");
    expect(nextStatusFor("reject")).toBe("REJECTED");
  });
});
