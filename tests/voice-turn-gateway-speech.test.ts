/**
 * UMRAIO® VOICE — SPEECH OWNERSHIP CONTRACT
 *
 * The serverless control plane cannot compile an Opus encoder, so a live call
 * turn must return TEXT plus the LOCKED MiniMax identity and let the media
 * gateway synthesize. Worker-side TTS only runs behind CALL_TTS_IN_WORKER=1.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  synthesizeCallSpeech: vi.fn(),
  transcribeAudio: vi.fn(),
}));

vi.mock("@/lib/calls/call-audio.server", () => ({
  synthesizeCallSpeech: mocks.synthesizeCallSpeech,
}));
vi.mock("@/lib/voice/asr.server", () => ({ transcribeAudio: mocks.transcribeAudio }));
vi.mock("@/lib/ai/gateway.server", () => ({
  createIntelligenceGateway: () => ({
    chat: async () => ({ ok: true, text: "Waalaikumsalam, saya RAIO." }),
  }),
}));

import { handleVoiceTurn } from "@/lib/calls/voice-turn.server";

function makeDb() {
  const row = {
    id: "s1",
    agency_id: "a1",
    call_id: "wacid_1",
    caller_phone: "60123",
    status: "answered",
    meta_accepted_at: new Date().toISOString(),
    transcript: [],
    turn_count: 0,
    detected_language: "ms",
    voice_intents: [],
  };
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: row, error: null }),
    single: async () => ({ data: row, error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
    limit: () => builder,
  };
  return { from: () => builder } as never;
}

describe("VOICE TURN — gateway speech contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["CALL_TTS_IN_WORKER"];
  });

  it("returns speech text and the locked voice identity without worker TTS", async () => {
    const result = await handleVoiceTurn({
      db: makeDb(),
      payload: { call_id: "wacid_1", sequence: 1, kind: "greeting" } as never,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replyOggBase64).toBeNull();
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.voiceId).toBe("Malay_male_1_v1");
    expect(result.languageBoost).toBe("Malay");
    // No substitute provider, and no impossible Worker encode attempt.
    expect(mocks.synthesizeCallSpeech).not.toHaveBeenCalled();
  });

  it("still renders audio in the Worker when explicitly opted in", async () => {
    process.env["CALL_TTS_IN_WORKER"] = "1";
    mocks.synthesizeCallSpeech.mockResolvedValue({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      engine: "minimax",
    });

    const result = await handleVoiceTurn({
      db: makeDb(),
      payload: { call_id: "wacid_1", sequence: 1, kind: "greeting" } as never,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.synthesizeCallSpeech).toHaveBeenCalledTimes(1);
    expect(result.replyOggBase64).toBeTruthy();
  });
});
