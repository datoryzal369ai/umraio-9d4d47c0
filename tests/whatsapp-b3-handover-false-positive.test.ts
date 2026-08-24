import { describe, expect, it } from "vitest";

import { detectHumanRequest } from "@/lib/sales/hardening.core";

/**
 * INCIDENT 2026-08-24 (PHASE B-3) — a voice turn transcribed as
 * "Kenapa cakap macam robot? Cakap macam orang." was classified as an explicit
 * human-handover request. The conversation was set to ai_enabled=false and
 * every later customer message ("Salam", "Kenapa senyap?", "Helooo") received
 * no reply at all.
 */
describe("B-3 regression — manner-of-speech is never a human handover request", () => {
  it("style instructions do not trigger a takeover", () => {
    for (const phrase of [
      "Kenapa cakap macam robot? Cakap macam orang.",
      "cakap macam orang biasa la",
      "jawab macam manusia sikit",
      "boleh tak balas macam orang normal",
      "talk like a real person please",
      "awak bunyi macam robot",
    ]) {
      expect(detectHumanRequest(phrase)).toBe(false);
    }
  });

  it("genuine human handover requests are still detected", () => {
    for (const phrase of [
      "saya nak cakap dengan staff",
      "boleh sambungkan saya kepada pegawai",
      "nak bercakap dengan manusia",
      "transfer me to a human",
      "i want to speak to a real agent",
    ]) {
      expect(detectHumanRequest(phrase)).toBe(true);
    }
  });

  it("a style complaint plus a genuine request still hands over", () => {
    expect(detectHumanRequest("cakap macam orang biasa, sambungkan saya kepada staff")).toBe(true);
  });
});
