import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ asr: vi.fn(), generate: vi.fn(), send: vi.fn(), synthesize: vi.fn() }));
vi.mock("@/lib/voice/asr.server", () => ({ transcribeAudio: mocks.asr }));
vi.mock("@/lib/ai/gateway.server", () => ({ createIntelligenceGateway: () => ({ generate: mocks.generate }) }));
vi.mock("@/lib/whatsapp-send.server", () => ({ sendWhatsappTextDetailed: mocks.send }));
vi.mock("@/lib/calls/call-audio.server", () => ({ synthesizeCallSpeech: mocks.synthesize }));
import { handleVoiceTurn } from "@/lib/calls/voice-turn.server";
import { callingDb } from "./helpers/calling-worker-db";

const payload = { call_id: "synthetic-call", sequence: 2, kind: "utterance" as const, audio_ogg_base64: "AQI=", duration_ms: 800 };
beforeEach(() => {
  vi.clearAllMocks(); delete process.env.CALL_TTS_IN_WORKER;
  mocks.generate.mockResolvedValue({ ok: true, data: "Deposit tempahan sudah dibayar." });
  mocks.asr.mockResolvedValue({ ok: true, text: "Macam mana status booking saya?" });
  mocks.send.mockResolvedValue({ ok: true, providerMessageId: "wamid.synthetic" });
});

describe("Worker-only executive conversation integration", () => {
  it("preserves exact system-first greeting text and gateway speech identity", async () => {
    const fixture = callingDb();
    const result = await handleVoiceTurn({ db: fixture.db, payload: { ...payload, kind: "greeting", sequence: 1, audio_ogg_base64: null } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Existing spoken formatter adds the pause and caps the opening length.
    expect(result.text).toBe("Assalamualaikum Dato' Amin. Saya RAIŌ, AI dari Synthetic Agency. Panggilan ini mungkin dirakam, untuk kualiti dan latihan. Apa khabar?");
    expect(result.voiceId).toBe("Malay_male_1_v1"); expect(result.languageBoost).toBe("Malay");
    expect(result.replyOggBase64).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.synthesize).not.toHaveBeenCalled();
    expect(fixture.tables.whatsapp_call_sessions![0].transcript.at(-1).delivery).toBe("generated");
  });
  it("supplies authoritative state and confirmed history, excluding undelivered assistant fiction", async () => {
    const fixture = callingDb();
    fixture.tables.whatsapp_call_sessions![0].transcript = [
      { role: "customer", text: "Saya sudah bayar", at: "now" },
      { role: "umraio", text: "Fiction: booking pending", at: "now", sequence: 1, delivery: "generated" },
    ];
    await handleVoiceTurn({ db: fixture.db, payload });
    const input = mocks.generate.mock.calls[0]![0];
    expect(input.system).toContain("deposit_paid=true"); expect(input.system).toContain("RM29400");
    expect(input.system).toContain("override lead sales stage");
    expect(input.system).toContain('"quotation_total":29400');
    expect(input.messages.map((m: { content: string }) => m.content)).toEqual(["Saya sudah bayar", "Macam mana status booking saya?"]);
    expect(input.context.allowedTools).toEqual([]);
    expect(fixture.tables.whatsapp_call_sessions![0].transcript).toHaveLength(4);
  });
  it("requires an actually played confirmation before updating traveller count", async () => {
    const fixture = callingDb();
    mocks.asr.mockResolvedValue({ ok: true, text: "Untuk 4 orang" });
    await handleVoiceTurn({ db: fixture.db, payload });
    expect(fixture.tables.whatsapp_call_sessions![0].voice_traveller_count).toBeUndefined();
    mocks.asr.mockResolvedValue({ ok: true, text: "Ya betul" });
    await handleVoiceTurn({ db: fixture.db, payload: { ...payload, sequence: 3 } });
    expect(fixture.tables.whatsapp_call_sessions![0].voice_traveller_count).toBeUndefined();
    await handleVoiceTurn({ db: fixture.db, payload: { ...payload, sequence: 4, media_metrics: { prev_sequence: 3, playback_complete_ms: 1500 } } });
    expect(fixture.tables.whatsapp_call_sessions![0].voice_traveller_count).toBe(4);
    expect(fixture.tables.bookings![0].pax).toBe(3);
    expect(fixture.tables.leads![0].pax).toBe(3);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each(["Ja", "Skjab, skjab"])("clarifies %s without changing identity or invoking reasoning", async text => {
    mocks.asr.mockResolvedValue({ ok: true, text });
    const fixture = callingDb();
    const before = JSON.stringify(fixture.tables.leads);
    const result = await handleVoiceTurn({ db: fixture.db, payload });
    expect(result.ok && result.text).toContain("Boleh ulang");
    expect(JSON.stringify(fixture.tables.leads)).toBe(before);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("dispatches the requested quotation before committing verified completion speech", async () => {
    mocks.asr.mockResolvedValue({ ok: true, text: "Hantar quotation sekarang dekat WhatsApp, boleh?" });
    const fixture = callingDb();
    let release!: (value: unknown) => void;
    mocks.send.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = handleVoiceTurn({ db: fixture.db, payload });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(fixture.tables.whatsapp_call_sessions![0].transcript).toEqual([]);
    release({ ok: true, providerMessageId: "wamid.synthetic" });
    const result = await pending;
    expect(result.ok && result.text).toContain("sudah dihantar");
    expect(fixture.tables.whatsapp_call_sessions![0].transcript.at(-1).actionReceipt.providerMessageId).toBe("wamid.synthetic");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("responds truthfully when quotation execution is unavailable", async () => {
    mocks.asr.mockResolvedValue({ ok: true, text: "Hantar quotation sekarang dekat WhatsApp, boleh?" });
    const fixture = callingDb({ whatsapp_configs: [] });
    const result = await handleVoiceTurn({ db: fixture.db, payload });
    expect(result.ok && result.text).toContain("belum boleh sahkan");
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("prevents generated unexecuted promises on ordinary reasoning turns", async () => {
    mocks.generate.mockResolvedValue({ ok: true, data: "Saya akan hantar kemas kini ke WhatsApp." });
    const result = await handleVoiceTurn({ db: callingDb().db, payload });
    expect(result.ok && result.text).toContain("Belum ada pengesahan");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("prevents a stale generated pending-booking claim from overriding the paid deposit", async () => {
    mocks.generate.mockResolvedValue({ ok: true, data: "Booking masih pending, deposit belum dibayar." });
    const result = await handleVoiceTurn({ db: callingDb().db, payload });
    expect(result.ok && result.text).toBe("Rekod tempahan menunjukkan deposit sudah dibayar.");
  });
  it("labels an earlier uncertain fragment instead of feeding it back as a name", async () => {
    const fixture = callingDb();
    mocks.asr.mockResolvedValueOnce({ ok: true, text: "Ja" });
    await handleVoiceTurn({ db: fixture.db, payload });
    await handleVoiceTurn({ db: fixture.db, payload: { ...payload, sequence: 3 } });
    const input = mocks.generate.mock.calls[0]![0];
    expect(input.messages[0].content).toBe("[Uncertain ASR fragment, not an entity fact] Ja");
  });
  it("uses the existing backchannel threshold while verified dispatch is pending", async () => {
    vi.useFakeTimers();
    try {
      mocks.asr.mockResolvedValue({ ok: true, text: "Hantar quotation sekarang dekat WhatsApp, boleh?" });
      let release!: (value: unknown) => void;
      mocks.send.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const emit = vi.fn();
      const fixture = callingDb();
      const pending = handleVoiceTurn({ db: fixture.db, payload, onAcknowledgement: emit });
      await vi.advanceTimersByTimeAsync(249);
      expect(emit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0]![0].text).toBe("Baik Dato'.");
      release({ ok: true, providerMessageId: "wamid.synthetic" });
      await pending;
      await vi.advanceTimersByTimeAsync(1000);
      expect(emit).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it.each(["Oklah itulah, nanti saya call awak balik.", "Terima kasih, selamat tinggal.", "Awak tak putuskan ke?"])("commits farewell and existing endCall contract for %s", async text => {
    mocks.asr.mockResolvedValue({ ok: true, text });
    const fixture = callingDb();
    const result = await handleVoiceTurn({ db: fixture.db, payload });
    expect(result).toMatchObject({ ok: true, endCall: true, reason: "conversation_complete" });
    expect(fixture.tables.whatsapp_call_sessions![0].closing_state).toBe("farewell");
    expect(mocks.generate).not.toHaveBeenCalled();
    const duplicate = await handleVoiceTurn({ db: fixture.db, payload: { ...payload, sequence: 3, kind: "greeting" } });
    expect(duplicate).toEqual({ ok: false, reason: "farewell_committed" });
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
