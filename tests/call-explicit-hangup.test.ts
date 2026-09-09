import { describe, expect, it } from "vitest";

import { advanceClosing, isExplicitHangupCommand } from "@/lib/calls/call-experience.core";

const base = { language: "ms", turnCount: 3, maxTurns: 40 } as const;

describe("explicit hangup command", () => {
  it("recognises the exact founder phrase and returns a farewell immediately", () => {
    const out = advanceClosing({
      ...base,
      state: "active",
      transcript: "Awak putuskanlah, saya dah selesai cakap dengan awak.",
    });
    expect(out.action).toBe("farewell");
    expect(out.state).toBe("farewell");
    expect(out.action === "farewell" && out.text.length > 0).toBe(true);
  });

  it("outranks pending work", () => {
    const out = advanceClosing({
      ...base,
      state: "active",
      pendingWork: true,
      transcript: "Tamatkan panggilan sekarang.",
    });
    expect(out.action).toBe("farewell");
  });

  it("works from completion_check state too", () => {
    const out = advanceClosing({
      ...base,
      state: "completion_check",
      transcript: "Please hang up.",
      language: "en",
    });
    expect(out.action).toBe("farewell");
  });

  it.each([
    "Awak putuskanlah.",
    "Putuskan talian ya.",
    "Boleh tamatkan panggilan?",
    "Can you end the call please?",
    "You can hang up now",
    "End the call please",
    "Letak telefon ya.",
  ])("treats %s as a hangup command", (phrase) => {
    expect(isExplicitHangupCommand(phrase)).toBe(true);
  });

  it.each([
    "Jangan putuskan talian dulu.",
    "Please don't hang up.",
    "Okey okey, dah. Awak putuskan tadian?",
    "Talian tadi terputus sebentar.",
    "Saya nak tamatkan tempahan umrah saya.",
    "Saya nak putuskan tempahan umrah saya.",
    "Saya nak putuskan jumlah bayaran.",
    "Berapa harga pakej sepuluh hari?",
  ])("does not treat %s as a hangup command", (phrase) => {
    expect(isExplicitHangupCommand(phrase)).toBe(false);
  });

  it("closes standalone thanks but preserves a new question", () => {
    const out = advanceClosing({ ...base, state: "active", transcript: "Terima kasih." });
    expect(out.action).toBe("farewell");
    const cont = advanceClosing({ ...base, state: "active", transcript: "Nak tanya satu lagi." });
    expect(cont.action).toBe("continue");
  });
});
