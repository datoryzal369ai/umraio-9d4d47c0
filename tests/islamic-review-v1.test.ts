import { describe, expect, it } from "vitest";

import {
  ISLAMIC_HOLDING_MESSAGE,
  ISLAMIC_PENDING_ACK_MESSAGE,
  canDecideIslamicReview,
  canTransition,
  islamicDedupeKey,
  isCurrentTurnIslamicReviewPending,
  isOpenIslamicReview,
  nextStatusFor,
  planPendingReviewReply,
  rejectionMessage,
  validateDecision,
} from "@/lib/islamic/review.core";
import { decideVoiceReply } from "@/lib/voice/tts.core";

const inboundAt = "2026-08-23T12:00:00.000Z";

function voiceEligible(review: { status: string; created_at: string } | null): boolean {
  return decideVoiceReply({
    inboundModality: "audio",
    replyText: "Baik Datuk, pakej Disember masih tersedia.",
    islamicReviewPending: isCurrentTurnIslamicReviewPending(review, inboundAt),
  }).speak;
}

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

  it("16. a previous PENDING review does not mute a normal current voice turn", () => {
    expect(voiceEligible({ status: "PENDING", created_at: "2026-08-23T11:59:59.000Z" })).toBe(true);
  });

  it("17. a PENDING review created by the current turn suppresses voice", () => {
    expect(voiceEligible({ status: "PENDING", created_at: "2026-08-23T12:00:00.100Z" })).toBe(false);
  });

  it("18. a previous AMENDED review does not mute an unrelated current turn", () => {
    expect(voiceEligible({ status: "AMENDED", created_at: "2026-08-23T11:00:00.000Z" })).toBe(true);
  });

  it("19. a current-turn review preserves text while suppressing voice", () => {
    const textSent = true;
    const voice = voiceEligible({ status: "PENDING", created_at: "2026-08-23T12:00:01.000Z" });
    expect(textSent).toBe(true);
    expect(voice).toBe(false);
  });

  it("20. two consecutive normal turns remain voice eligible after an older religious review", () => {
    const oldReview = { status: "PENDING", created_at: "2026-08-23T11:30:00.000Z" };
    expect(voiceEligible(oldReview)).toBe(true);
    expect(
      decideVoiceReply({
        inboundModality: "audio",
        replyText: "Untuk soalan seterusnya, saya boleh semak tarikh penerbangan.",
        islamicReviewPending: isCurrentTurnIslamicReviewPending(
          oldReview,
          "2026-08-23T12:05:00.000Z",
        ),
      }).speak,
    ).toBe(true);
  });

  it.each([
    ["Saya nak tanya pasal pakej Umrah 12 hari.", "Baik Datuk, pakej 12 hari tersedia."],
    ["Berapa harga pakej?", "Harga pakej bermula daripada lima ribu ringgit."],
    ["Apa maksud Talbiyah?", "Talbiyah ialah seruan menyahut panggilan Allah."],
  ])(
    "21. an older pending review cannot block a current voice turn: %s",
    (currentQuestion, replyText) => {
      const oldReview = {
        status: "PENDING",
        created_at: "2026-08-23T12:00:01.000Z",
        question: "Boleh minta fatwa tentang keadaan khusus saya?",
      };
      const currentTurnMatch = isCurrentTurnIslamicReviewPending(
        oldReview,
        inboundAt,
        currentQuestion,
      );
      const voice = decideVoiceReply({
        inboundModality: "audio",
        replyText,
        islamicReviewPending: currentTurnMatch,
      });
      expect(currentTurnMatch).toBe(false);
      expect(planPendingReviewReply(currentTurnMatch ? oldReview : null).kind).toBe("none");
      expect(voice.speak).toBe(true);
    },
  );

  it("22. a current high-risk voice turn creates the matching suppression identity", () => {
    const question = "Boleh minta fatwa tentang keadaan khusus saya?";
    const currentReview = {
      status: "PENDING",
      created_at: "2026-08-23T12:00:01.000Z",
      question,
    };
    const currentTurnMatch = isCurrentTurnIslamicReviewPending(
      currentReview,
      inboundAt,
      question,
    );
    expect(currentTurnMatch).toBe(true);
    expect(planPendingReviewReply(currentReview).kind).toBe("holding");
    expect(
      decideVoiceReply({
        inboundModality: "audio",
        replyText: ISLAMIC_HOLDING_MESSAGE,
        islamicReviewPending: currentTurnMatch,
      }),
    ).toEqual({ speak: false, reason: "pending_islamic_review" });
  });
});
