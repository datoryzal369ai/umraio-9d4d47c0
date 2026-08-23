import { describe, expect, it, vi, beforeEach } from "vitest";

import { resolveVoiceLanguage } from "@/lib/voice/language.core";

const calls: string[] = [];
const quota = { remainingMinutes: 1 };

vi.mock("@/lib/billing/usage.server", () => {
  class QuotaError extends Error {
    kind: string;
    constructor(kind: string) {
      super(kind);
      this.kind = kind;
    }
  }
  return {
    QuotaError,
    assertVoiceQuota: async (_db: unknown, _agency: string, requestedSeconds = 0) => {
      calls.push(`quota:${requestedSeconds}`);
      const requestedMinutes = Math.ceil(Math.max(0, requestedSeconds) / 60);
      if (requestedMinutes > quota.remainingMinutes) throw new QuotaError("exceeded");
      return { remaining: quota.remainingMinutes };
    },
    recordUsageEvent: async () => {
      calls.push("meter");
    },
  };
});

vi.mock("@/lib/voice/media.server", () => ({
  fetchWhatsappAudio: async () => {
    calls.push("media");
    return {
      ok: true,
      bytes: new Uint8Array(40_000),
      byteLength: 40_000,
      mimeType: "audio/ogg",
    };
  },
}));

vi.mock("@/lib/voice/asr.server", () => ({
  ASR_MODEL: "test-asr",
  transcribeAudio: async () => {
    calls.push("asr");
    return { ok: true, text: "salam", durationSeconds: 20 };
  },
}));

const ingest = async () => {
  const { ingestVoiceNote } = await import("@/lib/voice/inbound.server");
  return ingestVoiceNote({} as never, {
    agencyId: "agency-1",
    mediaId: "media-1",
    accessToken: "tok",
    providerMessageId: "wamid.1",
    voiceLanguage: "ms-MY",
  });
};

beforeEach(() => {
  calls.length = 0;
  quota.remainingMinutes = 1;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("two-stage voice quota gate", () => {
  it("checks quota before media download and again with the real duration before ASR", async () => {
    const result = await ingest();
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["quota:0", "media", "quota:20", "asr", "meter"]);
  });

  it("rejects a note that would cross the monthly limit before ASR or AI", async () => {
    quota.remainingMinutes = 0;
    // exhausted bucket: gate 1 already denies, media is never fetched
    const exhausted = await ingest();
    expect(exhausted.ok).toBe(false);
    expect(calls).toEqual(["quota:0"]);
  });

  it("denies at the duration-aware gate when only the crossing note exceeds the allowance", async () => {
    let seen = 0;
    quota.remainingMinutes = 1;
    const spy = vi.fn();
    void spy;
    // simulate a bucket with room for the 0s pre-check but not for a 20s note
    const { ingestVoiceNote } = await import("@/lib/voice/inbound.server");
    const usage = await import("@/lib/billing/usage.server");
    const original = usage.assertVoiceQuota;
    (usage as unknown as { assertVoiceQuota: unknown }).assertVoiceQuota = async (
      _db: unknown,
      _agency: string,
      requestedSeconds = 0,
    ) => {
      seen += 1;
      calls.push(`quota:${requestedSeconds}`);
      if (requestedSeconds > 0) throw new usage.QuotaError("exceeded");
      return { remaining: 1 };
    };
    const result = await ingestVoiceNote({} as never, {
      agencyId: "agency-1",
      mediaId: "media-1",
      accessToken: "tok",
      providerMessageId: "wamid.2",
      voiceLanguage: "ms-MY",
    });
    (usage as unknown as { assertVoiceQuota: unknown }).assertVoiceQuota = original;
    expect(seen).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quota_exceeded");
    expect(calls).not.toContain("asr");
    expect(calls).not.toContain("meter");
  });

  it("still resolves a missing voice language to Malaysian Malay", () => {
    expect(resolveVoiceLanguage(undefined)).toBe("ms-MY");
  });
});
