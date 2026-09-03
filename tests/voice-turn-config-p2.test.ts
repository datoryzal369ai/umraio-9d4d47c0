/**
 * P-2 SURGICAL FIX — voice configuration must come from agency_settings,
 * never whatsapp_configs, and the resolved persona must reach
 * prepareSpokenResponse unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const asrMock = vi.hoisted(() => ({ transcribeAudio: vi.fn() }));
const ttsMock = vi.hoisted(() => ({
  synthesizeSpeech: vi.fn(),
  // The call path pins the MiniMax engine explicitly (voice lock).
  lazyMinimaxEngine: { name: "minimax", synthesize: vi.fn() },
}));
const gatewayMock = vi.hoisted(() => ({ createIntelligenceGateway: vi.fn() }));
const presentationMock = vi.hoisted(() => ({ prepareSpokenResponse: vi.fn() }));

vi.mock("@/lib/voice/asr.server", () => asrMock);
vi.mock("@/lib/voice/tts.server", () => ttsMock);
vi.mock("@/lib/ai/gateway.server", () => gatewayMock);
vi.mock("@/lib/voice/tts.core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/voice/tts.core")>();
  return { ...original, prepareSpokenResponse: presentationMock.prepareSpokenResponse };
});

import { handleVoiceTurn } from "@/lib/calls/voice-turn.server";

// Minimal but VALID OGG page carrying an OpusHead identification header.
const OGG_BYTES = (() => {
  const bytes = new Uint8Array(40);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 28); // "OpusHead"
  return bytes;
})();
const OGG_B64 = btoa(String.fromCharCode(...OGG_BYTES));

const sessionRow = {
  id: "s1",
  agency_id: "agency-A",
  call_id: "wacid.1",
  caller_phone: "60111063999",
  status: "answered",
  meta_accepted_at: "2026-08-31T00:00:00.000Z",
  transcript: [],
  turn_count: 0,
  detected_language: null,
  voice_intents: [],
};

type TableReply = { data: unknown; error: null };

function buildDb(rows: Record<string, unknown>, queries: Array<{ table: string; select: string; eq: Record<string, string> }>) {
  const db = {
    from(table: string) {
      return {
        select(select: string) {
          return {
            eq(column: string, value: string) {
              return {
                maybeSingle(): TableReply {
                  queries.push({ table, select, eq: { [column]: value } });
                  return { data: rows[table] ?? null, error: null };
                },
              };
            },
          };
        },
        update() {
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  };
  return db;
}

describe("P-2 voice configuration retrieval", () => {
  let queries: Array<{ table: string; select: string; eq: Record<string, string> }>;

  beforeEach(() => {
    queries = [];
    vi.clearAllMocks();
    asrMock.transcribeAudio.mockResolvedValue({ ok: true, text: "Saya nak tempah umrah" });
    gatewayMock.createIntelligenceGateway.mockReturnValue({
      generate: vi.fn().mockResolvedValue({ ok: true, data: "Baik tuan, boleh saya bantu." }),
    });
    presentationMock.prepareSpokenResponse.mockReturnValue({
      spokenText: "Baik tuan, boleh saya bantu.",
      personaKey: "premium_sales_executive",
      controls: {},
      voice: "marin",
      speed: 0.97,
      instructions: "instr",
      verbatim: false,
      estimatedSeconds: 5,
      lengthClass: "short",
      opening: null,
    });
    ttsMock.synthesizeSpeech.mockResolvedValue({
      ok: true,
      bytes: OGG_BYTES,
      mimeType: "audio/ogg",
    });
  });

  async function runTurn(settingsRow: unknown, agencyId = "agency-A") {
    const db = buildDb(
      {
        whatsapp_call_sessions: { ...sessionRow, agency_id: agencyId },
        agency_settings: settingsRow,
        agencies: { name: "UMRAX TRAVEL AGENCY" },
      },
      queries,
    );
    const result = await handleVoiceTurn({
      db: db as never,
      payload: { call_id: "wacid.1", kind: "utterance", audio_ogg_base64: OGG_B64, duration_ms: 1200 },
    });
    return result;
  }

  it("reads voice_language from agency_settings, scoped to the session agency", async () => {
    const settings = {
      voice_persona: "premium_sales_executive",
      voice_controls: { warmth: 80, pace: 55 },
      voice_name: "cedar",
      voice_language: "ms-MY",
    };
    const result = await runTurn(settings);
    expect(result.ok).toBe(true);

    const settingsQuery = queries.find((q) => q.table === "agency_settings");
    expect(settingsQuery).toBeDefined();
    expect(settingsQuery!.select).toBe("voice_persona, voice_controls, voice_name, voice_language");
    expect(settingsQuery!.eq.agency_id).toBe("agency-A");
  });

  it("never queries whatsapp_configs for voice configuration", async () => {
    await runTurn({
      voice_persona: "premium_sales_executive",
      voice_controls: {},
      voice_name: "marin",
      voice_language: "ms-MY",
    });
    expect(queries.some((q) => q.table === "whatsapp_configs")).toBe(false);
  });

  it("passes voice_persona, voice_controls and voice_name to prepareSpokenResponse", async () => {
    const controls = { warmth: 90, pace: 40, pause: 60 };
    await runTurn({
      voice_persona: "warm_consultant",
      voice_controls: controls,
      voice_name: "cedar",
      voice_language: "ms-MY",
    });
    expect(presentationMock.prepareSpokenResponse).toHaveBeenCalledTimes(1);
    const arg = presentationMock.prepareSpokenResponse.mock.calls[0]![0] as {
      persona: { persona: string | null; controls: unknown; voice: string | null };
      language: string;
    };
    expect(arg.persona.persona).toBe("warm_consultant");
    expect(arg.persona.voice).toBe("cedar");
    expect(arg.persona.controls).toEqual(controls);
  });

  it("missing agency_settings configuration falls back safely without inventing values", async () => {
    const result = await runTurn(null);
    expect(result.ok).toBe(true);
    const arg = presentationMock.prepareSpokenResponse.mock.calls[0]![0] as {
      persona: { persona: string | null; controls: unknown; voice: string | null };
    };
    expect(arg.persona.persona).toBeNull();
    expect(arg.persona.voice).toBeNull();
    expect(arg.persona.controls).toBeNull();
  });

  it("queries agency_settings with the session agency id only (no cross-agency access)", async () => {
    await runTurn(
      { voice_persona: "warm_consultant", voice_controls: {}, voice_name: "marin", voice_language: "en-US" },
      "agency-B",
    );
    const settingsQuery = queries.find((q) => q.table === "agency_settings");
    expect(settingsQuery!.eq.agency_id).toBe("agency-B");
  });

  it("the client payload cannot override agency voice configuration", async () => {
    const db = buildDb(
      {
        whatsapp_call_sessions: sessionRow,
        agency_settings: {
          voice_persona: "premium_sales_executive",
          voice_controls: {},
          voice_name: "marin",
          voice_language: "ms-MY",
        },
        agencies: { name: "UMRAX TRAVEL AGENCY" },
      },
      queries,
    );
    await handleVoiceTurn({
      db: db as never,
      payload: {
        call_id: "wacid.1",
        kind: "greeting",
        duration_ms: 0,
        // Attempted client injection — must be ignored entirely.
        ...({ agency_id: "evil-agency", voice_language: "ar-SA", voice_name: "onyx" } as object),
      } as never,
    });
    const settingsQuery = queries.find((q) => q.table === "agency_settings");
    expect(settingsQuery!.eq.agency_id).toBe("agency-A");
    const arg = presentationMock.prepareSpokenResponse.mock.calls[0]![0] as {
      persona: { voice: string | null };
    };
    expect(arg.persona.voice).toBe("marin");
  });
});
