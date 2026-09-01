import { describe, expect, it } from "vitest";

import {
  MAX_STORED_TURNS,
  appendTranscript,
  classifyVoiceIntents,
  deriveCallOutcome,
  detectSpokenLanguage,
  detectTravellerCount,
  gateVoiceTurn,
  mergeIntents,
  parseVoiceTurnRequest,
  readTranscript,
  shouldEndCall,
  buildVoiceSystemPrompt,
  type VoiceTurnSessionRow,
} from "@/lib/calls/voice-turn.core";

const session = (over: Partial<VoiceTurnSessionRow> = {}): VoiceTurnSessionRow => ({
  id: "s1",
  agency_id: "a1",
  call_id: "wacid.1",
  caller_phone: "60111063999",
  status: "answered",
  meta_accepted_at: "2026-08-31T00:00:00.000Z",
  transcript: [],
  turn_count: 0,
  detected_language: null,
  voice_intents: [],
  ...over,
});

describe("voice turn payload parsing", () => {
  it("rejects an utterance with no audio", () => {
    expect(
      parseVoiceTurnRequest({ call_id: "c", kind: "utterance", audio_ogg_base64: "", duration_ms: 500 }),
    ).toBeNull();
  });

  it("accepts a greeting without audio", () => {
    const parsed = parseVoiceTurnRequest({ call_id: "c", kind: "greeting", sequence: 1, duration_ms: 0 });
    expect(parsed?.kind).toBe("greeting");
    expect(parsed?.audio_ogg_base64).toBeNull();
  });

  it("rejects unknown kinds and missing call ids", () => {
    expect(parseVoiceTurnRequest({ call_id: "c", kind: "dtmf" })).toBeNull();
    expect(parseVoiceTurnRequest({ call_id: "  ", kind: "greeting" })).toBeNull();
  });
});

describe("turn gating", () => {
  it("allows an accepted, live call", () => {
    expect(gateVoiceTurn(session())).toEqual({ allow: true });
  });

  it("refuses to speak before Meta accepted the call", () => {
    expect(gateVoiceTurn(session({ meta_accepted_at: null }))).toEqual({ allow: false, reason: "not_accepted" });
  });

  it("refuses terminal calls and unknown calls", () => {
    expect(gateVoiceTurn(session({ status: "completed" })).allow).toBe(false);
    expect(gateVoiceTurn(null)).toEqual({ allow: false, reason: "unknown_call" });
  });

  it("bounds runaway conversations", () => {
    expect(gateVoiceTurn(session({ turn_count: MAX_STORED_TURNS }))).toEqual({
      allow: false,
      reason: "turn_limit",
    });
  });
});

describe("multilingual understanding", () => {
  it("detects Malay, English and Arabic from the caller's own words", () => {
    expect(detectSpokenLanguage("Saya nak tempah pakej umrah", "en-US")).toBe("ms-MY");
    expect(detectSpokenLanguage("How much is the package please", "ms-MY")).toBe("en-US");
    expect(detectSpokenLanguage("السلام عليكم أريد العمرة", "ms-MY")).toBe("ar-SA");
  });

  it("falls back to the agency language when there is no signal", () => {
    expect(detectSpokenLanguage("...", "ms-MY")).toBe("ms-MY");
  });
});

describe("intent + outcome", () => {
  it("classifies booking, payment and handover intents", () => {
    expect(classifyVoiceIntents("saya nak tempah dan bayar deposit")).toEqual(
      expect.arrayContaining(["booking", "payment"]),
    );
    expect(classifyVoiceIntents("can I speak to a human")).toContain("handover");
    expect(classifyVoiceIntents("")).toEqual([]);
  });

  it("merges intents without duplicates", () => {
    expect(mergeIntents(["booking"], ["booking", "payment"])).toEqual(["booking", "payment"]);
  });

  it("derives outcome with handover taking priority", () => {
    const turns = [{ role: "customer" as const, text: "hi", at: "now" }];
    expect(deriveCallOutcome(["booking", "handover"], turns)).toBe("handover_required");
    expect(deriveCallOutcome([], [])).toBe("no_conversation");
  });

  it("captures traveller counts only when stated", () => {
    expect(detectTravellerCount("kami 4 orang")).toBe(4);
    expect(detectTravellerCount("berdua sahaja")).toBe(2);
    expect(detectTravellerCount("tak pasti lagi")).toBeNull();
  });
});

describe("transcript memory", () => {
  it("keeps only the most recent turns", () => {
    const many = Array.from({ length: MAX_STORED_TURNS + 5 }, (_, i) => ({
      role: "customer" as const,
      text: `t${i}`,
      at: "now",
    }));
    const merged = appendTranscript(many, [{ role: "umraio", text: "last", at: "now" }]);
    expect(merged.length).toBe(MAX_STORED_TURNS);
    expect(merged[merged.length - 1]?.text).toBe("last");
  });

  it("ignores malformed persisted transcripts", () => {
    expect(readTranscript("nope")).toEqual([]);
    expect(readTranscript([{ role: "bot", text: "x" }])).toEqual([]);
  });
});

describe("call termination", () => {
  it("ends on a real goodbye", () => {
    expect(shouldEndCall("ok terima kasih ya", 3)).toBe(true);
    expect(shouldEndCall("berapa harga pakej", 3)).toBe(false);
  });
});

describe("voice persona brief", () => {
  it("forbids invented facts and keeps replies spoken-length", () => {
    const prompt = buildVoiceSystemPrompt({
      agencyName: "Test Travel",
      preferredLanguage: "ms-MY",
      isGreeting: true,
      callerPhone: "60123",
    });
    expect(prompt).toContain("Test Travel");
    expect(prompt).toContain("Never invent prices");
    expect(prompt).toContain("Mirror the caller's language");
  });
});
