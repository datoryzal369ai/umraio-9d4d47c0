import { describe, expect, it } from "vitest";

import {
  classifyIslamicRisk,
  islamicRiskInstruction,
  requiresIslamicReview,
} from "@/lib/islamic/risk.core";
import {
  isCurrentTurnIslamicReviewPending,
  islamicDedupeKey,
  planPendingReviewReply,
} from "@/lib/islamic/review.core";

const tier = (q: string) => classifyIslamicRisk(q).tier;

describe("ISLAMIC IMPLEMENTATION LAYER V2.3 — BASIC auto-answer", () => {
  const basics = [
    "Apakah Rukun Islam?",
    "Apakah Rukun Iman?",
    "Apa maksud Talbiyah?",
    "Apakah urutan tawaf?",
    "Apa doa yang biasa dibaca ketika tawaf?",
    "Apa maksud sa'i?",
    "Apa maksud ihram?",
    "Apa adab masuk masjid?",
    "Bagaimana persediaan asas sebelum Umrah?",
  ];
  for (const q of basics) {
    it(`classifies BASIC: ${q}`, () => {
      expect(tier(q)).toBe("BASIC");
      expect(requiresIslamicReview(tier(q))).toBe(false);
      expect(islamicRiskInstruction("BASIC")).toContain("Do NOT call request_expert_review");
    });
  }
});

describe("ISLAMIC IMPLEMENTATION LAYER V2.3 — HIGH_RISK still reviewed", () => {
  const highRisk = [
    "Adakah tawaf saya sah kalau saya terlupa satu perkara?",
    "Apakah hukum melakukan perkara ini?",
    "Adakah saya perlu bayar dam dalam keadaan saya?",
    "Boleh minta fatwa pasal ini?",
    "Ini halal atau haram?",
    "Macam mana pembahagian faraid?",
  ];
  for (const q of highRisk) {
    it(`classifies HIGH_RISK: ${q}`, () => {
      expect(tier(q)).toBe("HIGH_RISK");
      expect(requiresIslamicReview(tier(q))).toBe(true);
    });
  }
});

describe("keywords alone never escalate", () => {
  it("normal sales questions are not religious at all", () => {
    expect(tier("Saya nak pakej Umrah 12 hari.")).not.toBe("HIGH_RISK");
    expect(tier("Berapa harga pakej?")).toBe(null);
  });
  it("basic terminology beats keyword presence", () => {
    expect(tier("Apa maksud Talbiyah?")).toBe("BASIC");
    expect(tier("Apakah urutan tawaf?")).toBe("BASIC");
  });
});

describe("no repeat loop / current-turn scope", () => {
  const turnStart = "2026-08-23T10:00:00.000Z";
  it("a previous-turn review never applies to the current turn", () => {
    expect(
      isCurrentTurnIslamicReviewPending(
        { status: "PENDING", created_at: "2026-08-23T09:00:00.000Z" },
        turnStart,
      ),
    ).toBe(false);
  });
  it("an AMENDED review from an earlier turn does not suppress", () => {
    expect(
      isCurrentTurnIslamicReviewPending(
        { status: "AMENDED", created_at: "2026-08-23T09:59:00.000Z" },
        turnStart,
      ),
    ).toBe(false);
  });
  it("a current-turn review suppresses only that turn", () => {
    expect(
      isCurrentTurnIslamicReviewPending(
        { status: "PENDING", created_at: "2026-08-23T10:00:01.000Z" },
        turnStart,
      ),
    ).toBe(true);
  });
  it("exactly one holding message per review", () => {
    expect(planPendingReviewReply({ status: "PENDING", holding_sent_at: null }).kind).toBe(
      "holding",
    );
    expect(
      planPendingReviewReply({ status: "PENDING", holding_sent_at: turnStart }).kind,
    ).toBe("acknowledge");
  });
  it("repeated identical high-risk question deduplicates", () => {
    expect(islamicDedupeKey("ritual", "Adakah tawaf saya sah?")).toBe(
      islamicDedupeKey("ritual", "  adakah TAWAF saya sah ?? "),
    );
  });
});
