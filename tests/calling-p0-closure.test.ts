import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateCallerContext, persistCallMemory } from "@/lib/calls/call-context.server";
import { parseGatewayCallback } from "@/lib/calls/gateway-callback.core";
import { parseVoiceTurnRequest } from "@/lib/calls/voice-turn.core";
import { loadContext } from "@/lib/sales-ai.server";

const mocks = vi.hoisted(() => ({ asr: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/voice/asr.server", () => ({ transcribeAudio: mocks.asr }));
vi.mock("@/lib/ai/gateway.server", () => ({
  createIntelligenceGateway: () => ({ generate: mocks.generate }),
}));

import { handleVoiceTurn } from "@/lib/calls/voice-turn.server";

type Row = Record<string, unknown>;

function memoryDb(options: { readError?: string; writeError?: string; foreign?: boolean } = {}) {
  const rows: Record<string, Row[]> = {
    leads: [{ id: "lead", agency_id: "agency", phone: "60123456789", full_name: "Encik Ali" }],
    conversations: [
      {
        id: "thread",
        agency_id: options.foreign ? "other" : "agency",
        lead_id: "lead",
        channel: "whatsapp",
      },
    ],
    messages: [
      {
        id: "text",
        agency_id: "agency",
        conversation_id: "thread",
        sender: "customer",
        body: "Pakej Ramadan",
        modality: "text",
        created_at: "2026-09-01",
      },
      {
        id: "audio",
        agency_id: "agency",
        conversation_id: "thread",
        sender: "customer",
        body: "Kami empat orang",
        modality: "audio",
        created_at: "2026-09-02",
      },
    ],
    whatsapp_call_sessions: [
      {
        id: "session",
        call_id: "call",
        agency_id: "agency",
        caller_phone: "60123456789",
        status: "answered",
        meta_accepted_at: "2026-09-08T00:00:00Z",
        transcript: [],
        conversation_id: "thread",
        lead_id: "lead",
        turn_count: 0,
        voice_intents: [],
        closing_state: "active",
      },
    ],
  };
  const writes: Array<{ table: string; patch: Row }> = [];
  const db = {
    from(table: string) {
      let patch: Row | null = null;
      let insert: Row | null = null;
      let limit = Infinity;
      let order: { key: string; ascending: boolean } | null = null;
      const filters: Array<(row: Row) => boolean> = [];
      const execute = async (single = false) => {
        if (!patch && !insert && options.readError === table)
          return { data: null, error: { code: "08006" } };
        if ((patch || insert) && options.writeError === table)
          return { data: null, error: { code: "23514" } };
        let selected = (rows[table] ?? []).filter((row) => filters.every((f) => f(row)));
        if (patch) {
          for (const row of selected) Object.assign(row, patch);
          writes.push({ table, patch });
        }
        if (insert) {
          const row = { id: `new-${writes.length}`, created_at: "2026-09-08", ...insert };
          (rows[table] ??= []).push(row);
          writes.push({ table, patch: insert });
          selected = [row];
        }
        if (order) {
          const { key, ascending } = order;
          selected = [...selected].sort(
            (a, b) =>
              String(a[key] ?? "").localeCompare(String(b[key] ?? "")) * (ascending ? 1 : -1),
          );
        }
        selected = selected.slice(0, limit);
        return { data: single ? (selected[0] ?? null) : selected, error: null };
      };
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters.push((r) => r[key] === value);
          return query;
        },
        in: (key: string, values: unknown[]) => {
          filters.push((r) => values.includes(r[key]));
          return query;
        },
        ilike: (key: string, value: string) => {
          filters.push((r) => String(r[key] ?? "").includes(value.replaceAll("%", "")));
          return query;
        },
        order: (key: string, args: { ascending: boolean }) => {
          order = { key, ascending: args.ascending };
          return query;
        },
        limit: (value: number) => {
          limit = value;
          return query;
        },
        update: (value: Row) => {
          patch = value;
          return query;
        },
        insert: (value: Row) => {
          insert = value;
          return query;
        },
        maybeSingle: () => execute(true),
        then: (
          resolve: (v: Awaited<ReturnType<typeof execute>>) => unknown,
          reject?: (e: unknown) => unknown,
        ) => execute().then(resolve, reject),
      };
      return query;
    },
  };
  return { db, rows, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CALL_TTS_IN_WORKER;
  mocks.asr.mockResolvedValue({ ok: true, text: "Boleh semak hotel untuk empat orang?" });
  mocks.generate.mockResolvedValue({
    ok: true,
    data: "Saya semak butiran hotel untuk empat orang.",
  });
});

describe("P0 cross-channel memory boundary", () => {
  it("carries text and voice notes into Calling and the call summary back into the actual WhatsApp context loader", async () => {
    const { db, rows } = memoryDb();
    const context = await hydrateCallerContext(db, {
      agencyId: "agency",
      callerPhone: "60123456789",
      conversationId: "thread",
    });
    expect(context.promptLines.join("\n")).toContain("Pakej Ramadan");
    expect(context.promptLines.join("\n")).toContain("(audio): Kami empat orang");
    const result = await handleVoiceTurn({
      db,
      payload: parseVoiceTurnRequest({
        call_id: "call",
        kind: "utterance",
        sequence: 2,
        audio_ogg_base64: "AQID",
      })!,
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(mocks.generate.mock.calls)).toContain("Kami empat orang");
    const summaries = rows.messages!.filter((r) => r.modality === "call_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      conversation_id: "thread",
      agency_id: "agency",
      delivery_status: "internal",
    });
    expect(String(summaries[0]!.body)).toContain("empat orang");
    const nextText = await loadContext(db, "thread");
    expect(
      nextText.messages.some(
        (m) => m.body.includes("empat orang") && m.body.includes("[call call]"),
      ),
    ).toBe(true);
    expect(nextText.recentCall?.call_summary).toContain("empat orang");
  });

  it("keeps the bound WhatsApp thread when a newer conversation exists", async () => {
    const { db, rows } = memoryDb();
    rows.conversations!.push({
      id: "new-thread",
      agency_id: "agency",
      lead_id: "lead",
      channel: "whatsapp",
      last_message_at: "2026-10-01",
    });
    const ctx = await hydrateCallerContext(db, {
      agencyId: "agency",
      callerPhone: "60123456789",
      conversationId: "thread",
    });
    expect(ctx.conversationId).toBe("thread");
  });

  it("updates the same internal summary on retry without creating another message", async () => {
    const { db, rows } = memoryDb();
    const args = {
      agencyId: "agency",
      conversationId: "thread",
      callId: "call",
      summary: "Empat orang",
    };
    expect(await persistCallMemory(db, args)).toBe("inserted");
    expect(await persistCallMemory(db, { ...args, summary: "Empat orang, hotel dekat" })).toBe(
      "updated",
    );
    expect(rows.messages!.filter((r) => r.modality === "call_summary")).toHaveLength(1);
  });

  it("refuses a thread belonging to another agency", async () => {
    const { db, writes } = memoryDb({ foreign: true });
    expect(
      await persistCallMemory(db, {
        agencyId: "agency",
        conversationId: "thread",
        callId: "call",
        summary: "Private",
      }),
    ).toBe("linkage_failed");
    expect(writes).toHaveLength(0);
  });

  it.each(["leads", "conversations", "messages"])(
    "reports %s context read errors instead of treating them as a new customer",
    async (table) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { db } = memoryDb({ readError: table });
      await expect(
        hydrateCallerContext(db, { agencyId: "agency", callerPhone: "60123456789" }),
      ).rejects.toThrow();
      expect(error.mock.calls.flat().join(" ")).toContain("08006");
      error.mockRestore();
    },
  );

  it("reports failed session persistence while still preserving useful thread memory", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, rows } = memoryDb({ writeError: "whatsapp_call_sessions" });
    const result = await handleVoiceTurn({
      db,
      payload: parseVoiceTurnRequest({ call_id: "call", kind: "greeting", sequence: 1 })!,
    });
    expect(result.ok).toBe(true);
    expect(error.mock.calls.flat().join(" ")).toContain("stage=turn_session");
    expect(error.mock.calls.flat().join(" ")).toContain("23514");
    expect(rows.messages!.some((r) => r.modality === "call_summary")).toBe(true);
    error.mockRestore();
  });
});

describe("P0 completion and telemetry boundary", () => {
  it("allows bounded silence to finish only after a completion question", async () => {
    const { db, rows } = memoryDb();
    const payload = parseVoiceTurnRequest({ call_id: "call", kind: "silence", sequence: 4 })!;
    expect(await handleVoiceTurn({ db, payload })).toEqual({
      ok: false,
      reason: "silence_not_awaited",
    });
    rows.whatsapp_call_sessions![0]!.closing_state = "completion_check";
    const result = await handleVoiceTurn({ db, payload });
    expect(result).toMatchObject({
      ok: true,
      endCall: true,
      reason: "conversation_complete",
      awaitingCompletion: false,
    });
    expect(mocks.asr).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(
      (rows.whatsapp_call_sessions![0]!.transcript as Row[]).some((r) => r.role === "customer"),
    ).toBe(false);
  });

  it("requests the bounded completion wait after a soft thank-you, preserving the farewell question", async () => {
    const { db } = memoryDb();
    mocks.asr.mockResolvedValue({ ok: true, text: "Ok terima kasih" });
    const result = await handleVoiceTurn({
      db,
      payload: parseVoiceTurnRequest({
        call_id: "call",
        kind: "utterance",
        sequence: 3,
        audio_ogg_base64: "AQID",
      })!,
    });
    expect(result).toMatchObject({ ok: true, endCall: false, awaitingCompletion: true });
  });

  it("accepts measured RTP times and discards invalid or future timing claims", () => {
    const event = {
      event: "media_ready",
      call_id: "call",
      session_id: "session",
      timestamp: "2026-09-08T00:00:03Z",
      nonce: "nonce",
    };
    expect(
      parseGatewayCallback({ ...event, first_inbound_rtp_at: "2026-09-08T00:00:01Z" })
        ?.first_inbound_rtp_at,
    ).toBe("2026-09-08T00:00:01Z");
    expect(
      parseGatewayCallback({ ...event, first_outbound_rtp_at: "invalid" })?.first_outbound_rtp_at,
    ).toBeUndefined();
    expect(
      parseGatewayCallback({ ...event, first_outbound_rtp_at: "2026-10-01T00:00:00Z" })
        ?.first_outbound_rtp_at,
    ).toBeUndefined();
  });
});
