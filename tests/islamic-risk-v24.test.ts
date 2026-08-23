import { describe, expect, it } from "vitest";

import {
  classifyIslamicRisk,
  mayEscalateIslamicReview,
  requiresIslamicReview,
} from "@/lib/islamic/risk.core";

const tier = (q: string) => classifyIslamicRisk(q).tier;

describe("IIL V2.4 — BASIC is instant", () => {
  for (const q of [
    "Apakah Rukun Islam?",
    "Apa maksud Talbiyah?",
    "Apa doa yang biasa dibaca ketika tawaf?",
    "Apa adab masuk masjid?",
  ]) {
    it(`BASIC: ${q}`, () => {
      expect(tier(q)).toBe("BASIC");
      expect(mayEscalateIslamicReview(tier(q))).toBe(false);
    });
  }
});

describe("IIL V2.4 — ordinary hukum questions are not auto-escalated", () => {
  it("Apakah hukum memakai ihram? → GUIDANCE, no review", () => {
    expect(tier("Apakah hukum memakai ihram?")).toBe("GUIDANCE");
    expect(mayEscalateIslamicReview("GUIDANCE")).toBe(false);
  });
  it("boleh atau tidak (impersonal, established) → GUIDANCE", () => {
    expect(tier("Boleh atau tidak pakai wangian sebelum ihram?")).toBe("GUIDANCE");
  });
});

describe("IIL V2.4 — SENSITIVE may escalate but is not mandatory", () => {
  it("unspecified act during ihram → SENSITIVE", () => {
    expect(tier("Apakah hukum jika melakukan perkara ini ketika ihram?")).toBe("SENSITIVE");
    expect(requiresIslamicReview("SENSITIVE")).toBe(false);
    expect(mayEscalateIslamicReview("SENSITIVE")).toBe(true);
  });
  it("dam in the abstract → SENSITIVE", () => {
    expect(tier("Bila dam dikenakan secara umum?")).toBe("SENSITIVE");
  });
});

describe("IIL V2.4 — HIGH_RISK still mandates human review", () => {
  for (const q of [
    "Berikan fatwa tentang perkara ini.",
    "Adakah tawaf saya sah kerana saya terlupa satu pusingan?",
    "Adakah saya perlu bayar dam dalam keadaan saya?",
    "Ini halal atau haram?",
    "Macam mana pembahagian faraid?",
    "Bagaimana proses talaq?",
  ]) {
    it(`HIGH_RISK: ${q}`, () => {
      expect(tier(q)).toBe("HIGH_RISK");
      expect(requiresIslamicReview(tier(q))).toBe(true);
    });
  }
});

describe("IIL V2.4 — keywords alone never escalate", () => {
  it("sales questions stay out of the layer", () => {
    expect(tier("Berapa harga pakej?")).toBe(null);
    expect(tier("Berapa hari pakej Umrah 12 hari?")).not.toBe("HIGH_RISK");
  });
  it("bare religious nouns are at most GUIDANCE", () => {
    for (const q of ["Masjid mana yang dekat?", "Umrah bila musim sejuk?", "Doa itu penting."]) {
      expect(mayEscalateIslamicReview(tier(q))).toBe(false);
    }
  });
});
