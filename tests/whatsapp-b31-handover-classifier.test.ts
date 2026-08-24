import { describe, expect, it } from "vitest";

import { detectHumanRequest } from "@/lib/sales/hardening.core";

/**
 * PHASE B-3.1 — human-handover classifier acceptance matrix.
 *
 * Style/manner complaints must never hand over; explicit requests for a person
 * always must, including when mixed with a style complaint in the same message.
 */
describe("B-3.1 human handover classifier", () => {
  it("category 1 — style complaints never hand over", () => {
    for (const phrase of [
      "Kenapa cakap macam robot?",
      "Cakap macam orang.",
      "Suara macam robot.",
      "Boleh cakap lebih natural?",
      "Jangan bunyi macam robot.",
      "Cakap Melayu macam orang biasa.",
      "Boleh ubah cara bercakap?",
      "Suara tu terlalu formal.",
    ]) {
      expect(detectHumanRequest(phrase), phrase).toBe(false);
    }
  });

  it("category 2 — explicit human requests always hand over", () => {
    for (const phrase of [
      "Saya nak cakap dengan staff.",
      "Boleh sambungkan saya dengan manusia?",
      "Saya nak bercakap dengan orang.",
      "Transfer saya kepada staff.",
      "Saya mahu human agent.",
      "Boleh bagi saya customer service?",
      "Saya nak bercakap dengan pegawai.",
      "Tolong sambungkan dengan manusia.",
    ]) {
      expect(detectHumanRequest(phrase), phrase).toBe(true);
    }
  });

  it("category 3 — mixed style complaint plus human request hands over", () => {
    for (const phrase of [
      "Cakap macam robot, saya nak staff.",
      "Suara macam robot. Boleh sambungkan saya dengan manusia?",
      "Saya tak suka cara awak jawab, bagi saya staff.",
    ]) {
      expect(detectHumanRequest(phrase), phrase).toBe(true);
    }
  });

  it("category 4 — ambiguous phrasing is not over-tightened into a handover", () => {
    for (const phrase of [
      "Saya nak orang yang boleh bantu.",
      "Saya perlukan bantuan orang.",
      "Boleh saya bercakap dengan seseorang?",
    ]) {
      expect(detectHumanRequest(phrase), phrase).toBe(false);
    }
  });
});
