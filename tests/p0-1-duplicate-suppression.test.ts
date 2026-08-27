import { describe, expect, it } from "vitest";

import {
  VOICE_FALLBACK_DEDUPE_WINDOW_MS,
  shouldSendSafetyAck,
  shouldSuppressVoiceFallback,
} from "@/lib/whatsapp/duplicate-suppression.core";

describe("P0-1 — DNC acknowledgement is sent once per transition", () => {
  it("sends ONE confirmation on the actual current-turn STOP transition", () => {
    expect(shouldSendSafetyAck({ currentState: "ACTIVE", targetState: "DO_NOT_CONTACT" })).toBe(
      true,
    );
    expect(shouldSendSafetyAck({ currentState: null, targetState: "DO_NOT_CONTACT" })).toBe(true);
  });

  it("does NOT resend the confirmation while the conversation stays muted", () => {
    expect(
      shouldSendSafetyAck({ currentState: "DO_NOT_CONTACT", targetState: "DO_NOT_CONTACT" }),
    ).toBe(false);
  });

  it("re-acknowledges after a historical DNC conversation was re-engaged", () => {
    // The re-engagement rule flips state back to ACTIVE on a customer-initiated
    // non-STOP turn; a later real STOP is a fresh transition again.
    expect(shouldSendSafetyAck({ currentState: "ACTIVE", targetState: "DO_NOT_CONTACT" })).toBe(
      true,
    );
  });

  it("applies the same rule to human handoff", () => {
    expect(shouldSendSafetyAck({ currentState: "HUMAN_HANDOFF", targetState: "HUMAN_HANDOFF" })).toBe(
      false,
    );
    expect(shouldSendSafetyAck({ currentState: "ACTIVE", targetState: "HUMAN_HANDOFF" })).toBe(true);
  });
});

describe("P0-1 — ASR-empty fallback repetition guard", () => {
  const now = Date.UTC(2026, 7, 27, 6, 0, 0);
  const base = { from: "60123456789", reason: "empty_transcript" };

  it("suppresses an identical fallback inside the window", () => {
    expect(
      shouldSuppressVoiceFallback({
        previous: { ...base, createdAt: new Date(now - 30_000).toISOString() },
        ...base,
        now,
      }),
    ).toBe(true);
  });

  it("allows a legitimate later fallback after the window", () => {
    expect(
      shouldSuppressVoiceFallback({
        previous: {
          ...base,
          createdAt: new Date(now - VOICE_FALLBACK_DEDUPE_WINDOW_MS - 1_000).toISOString(),
        },
        ...base,
        now,
      }),
    ).toBe(false);
  });

  it("never suppresses a different sender or a different reason", () => {
    expect(
      shouldSuppressVoiceFallback({
        previous: { from: "60999", reason: "empty_transcript", createdAt: new Date(now).toISOString() },
        ...base,
        now,
      }),
    ).toBe(false);
    expect(
      shouldSuppressVoiceFallback({
        previous: { ...base, reason: "download_failed", createdAt: new Date(now).toISOString() },
        ...base,
        now,
      }),
    ).toBe(false);
  });

  it("never suppresses the first fallback", () => {
    expect(shouldSuppressVoiceFallback({ previous: null, ...base, now })).toBe(false);
  });
});
