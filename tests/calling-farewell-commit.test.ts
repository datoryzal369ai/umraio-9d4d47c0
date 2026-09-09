import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ asr: vi.fn(), synth: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/voice/asr.server", () => ({ transcribeAudio: mocks.asr }));
vi.mock("@/lib/calls/call-audio.server", () => ({ synthesizeCallSpeech: mocks.synth }));
vi.mock("@/lib/ai/gateway.server", () => ({ createIntelligenceGateway: () => ({ generate: mocks.generate }) }));
import { handleVoiceTurn } from "@/lib/calls/voice-turn.server";

describe("Calling farewell commitment", () => {
  it("rejects a repeated system greeting without synthesis, reasoning or another completion question", async () => {
    const builder: any = {
      select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: {
        id: "test-session", agency_id: "test-agency", call_id: "test-call",
        status: "answered", meta_accepted_at: "2026-09-09T12:00:00Z",
        closing_state: "farewell", transcript: [], turn_count: 3,
      } }),
    };
    const from = vi.fn(() => builder);
    const result = await handleVoiceTurn({ db: { from } as never,
      payload: { call_id: "test-call", kind: "greeting", sequence: 4 } as never });
    expect(result).toEqual({ ok: false, reason: "farewell_committed" });
    expect(from).toHaveBeenCalledTimes(1);
    expect(mocks.asr).not.toHaveBeenCalled();
    expect(mocks.synth).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
