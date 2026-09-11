import { afterEach, describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/whatsapp-send.server", () => ({ sendWhatsappTextDetailed: send }));
import { handleCognitiveVoiceTurn } from "../src/lib/calls/cognitive-bridge.server";
import { CallingEngineFailure, callingEngineFailureEvidence } from "../src/lib/calls/cognitive-engine.server";
import { callingTurnResponse } from "../src/lib/calls/call-stream.server";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";
import type { CognitivePacket, CognitiveEngine, EngineMetadata } from "../src/lib/calls/cognitive-bridge.contract";
import { decisionFixture } from "./helpers/calling-cognitive-fixtures";
import { bridgeBusiness, businessIds } from "./helpers/calling-bridge-business";
import { binding } from "./helpers/calling-bridge-db";

const duplicate = "77777777-7777-4777-8777-777777777777";
const meta: EngineMetadata = { configured_provider: "fixture", configured_model: "unchanged", returned_provider: null,
  returned_model: null, started_at: "2026-09-11T11:20:12.064Z", completed_at: "2026-09-11T11:20:12.622Z",
  latency_ms: 558, input_tokens: null, output_tokens: null, fallback: false, cancellation: null };
const stores: Array<Awaited<ReturnType<typeof bridgeBusiness>> & { retained: Promise<unknown>[] }> = [];
afterEach(async () => { for (const f of stores.splice(0)) { await Promise.all(f.retained); await f.pg.close(); } vi.clearAllMocks(); });
async function runtime(otherName = "Other Contact") {
  const f = await bridgeBusiness(); const retained: Promise<unknown>[] = []; stores.push(Object.assign(f, { retained }));
  await f.pg.query("UPDATE leads SET full_name='Datuk Rizal' WHERE id=$1", [businessIds.lead]);
  await f.pg.query("INSERT INTO leads(id,agency_id,phone,full_name,do_not_contact) VALUES($1,$2,'60123456789',$3,false)", [duplicate,binding.agencyId,otherName]);
  let text = "Baiklah, saya nak cek tempahan saya boleh?";
  let decide: CognitiveEngine["decide"] = async ({ packet, signal }) => {
    const error = Object.assign(new Error("PRIVATE_PROVIDER_PAYLOAD"), { name: "AI_APICallError", statusCode: 503 });
    throw new CallingEngineFailure(meta, "Error", await callingEngineFailureEvidence(error, "provider_request", packet, signal, 558));
  };
  const model = vi.fn((input: Parameters<CognitiveEngine["decide"]>[0]) => decide(input));
  const args = { db: f.db, binding, lifetime: { retain: (p: Promise<unknown>) => { retained.push(p); } },
    callerPhone: "60123456789", language: "ms-MY", agencyName: "Synthetic", disclosureSpoken: false,
    voiceId: "locked", languageBoost: () => "Malay", present: async (text: string) => ({ text, replyOggBase64: null, voiceId: "locked", languageBoost: "Malay" }),
    engine: { decide: model }, asr: async () => ({ text, language: "ms", durationSeconds: 1, confidence: "unknown" as const, provider: "fixture", model: "fixture" }) };
  let previous = 0;
  const turn = (sequence: number, signal = new AbortController().signal, receivedAt = Date.now()) => handleCognitiveVoiceTurn({ ...args, receivedAt, signal,
    payload: { call_id: binding.callId, sequence, kind: sequence === 1 ? "greeting" : "utterance", duration_ms: 1000,
      audio_ogg_base64: sequence === 1 ? null : btoa(`fixture${sequence}`), ...(previous ? { media_metrics: { prev_sequence: previous, playback_complete_ms: 1000 } } : {}) } });
  const wire = async (sequence: number) => {
    const response = await callingTurnResponse({ streaming: true, signal: new AbortController().signal, run: async () => (await turn(sequence))! });
    const frames = (await response.text()).trim().split("\n").map(s => JSON.parse(s));
    await Promise.all(retained); previous = sequence; return frames.at(-1);
  };
  const snapshot = () => f.rpc("calling_bridge_snapshot", bindingArgs(binding));
  return { ...f, retained, model, turn, wire, snapshot, setText: (s: string) => { text = s; }, setEngine: (fn: CognitiveEngine["decide"]) => { decide = fn; } };
}
const lastPacket = (f: Awaited<ReturnType<typeof runtime>>): CognitivePacket => f.model.mock.calls.at(-1)![0].packet;
async function nameAnswer(f: Awaited<ReturnType<typeof runtime>>) {
  await f.wire(1); const first = await f.wire(2); f.setText("Datuk Rizal."); return { first, second: await f.wire(3) };
}

describe("latest Founder call and bounded identity continuation", () => {
  it("reproduces both exact utterances with sanitized failure evidence and one useful next question", async () => {
    const f = await runtime(); const { first, second } = await nameAnswer(f);
    expect(first.speech_text).toContain("Apakah nama penuh yang digunakan untuk tempahan itu?");
    expect(second.speech_text).toBe("Terima kasih, nama sudah saya terima. Untuk teruskan pengesahan, Apakah nombor rujukan sebut harga yang diterima daripada agensi?");
    expect(second.speech_text).not.toMatch(/nama penuh|macam mana|deposit|disahkan/);
    expect(second.speech_text.match(/\?/g)).toHaveLength(1);
    const p = lastPacket(f);
    expect(p.current_call.objective).toBe("Baiklah, saya nak cek tempahan saya boleh?");
    expect(p.current_call.caller_refs).toHaveLength(2); expect(p.current_call.delivered_assistant_refs).toHaveLength(2);
    expect(p.person.identity_refs).toEqual([]); expect(p.business.booking_refs).toEqual([]); expect(p.business.quotation_refs).toEqual([]); expect(p.available_actions).toEqual([]);
    expect(p.evidence.find(e => e.id === "runtime:identity_continuation")?.value).toMatchObject({ identity_verified: false, name_received: true, narrowed_candidate_count: 1 });
    const s = await f.snapshot(); expect(s.callers.map((c: {transcript:string}) => c.transcript).sort()).toEqual(["Baiklah, saya nak cek tempahan saya boleh?", "Datuk Rizal."].sort());
    for (const sequence of [2,3]) {
      const proposal = s.events.find((e: {kind:string;sequence:number}) => e.kind === "proposal" && e.sequence === sequence).payload;
      const telemetry = s.events.find((e: {kind:string;sequence:number}) => e.kind === "telemetry" && e.sequence === sequence).payload;
      expect(proposal).toMatchObject({ failure_classification: "AVAILABILITY_FAILURE", contract_repair: null,
        engine_failure: { failure_class: "PROVIDER_HTTP_ERROR", failure_stage: "provider_request", provider_http_status: 503, validation_stage: "before_semantic_validation" } });
      expect(telemetry.engine_failure).toEqual(proposal.engine_failure);
      expect(JSON.stringify(telemetry.engine_failure)).not.toMatch(/PRIVATE_PROVIDER_PAYLOAD|Rizal|tempahan/);
    }
    expect(f.model).toHaveBeenCalledTimes(2); expect(send).not.toHaveBeenCalled();
  });
  it("uses an existing reference to narrow equal-name contacts, without treating knowledge as authorization", async () => {
    const f = await runtime("Datuk Rizal"); await nameAnswer(f);
    expect(lastPacket(f).evidence.find(e => e.id === "runtime:identity_continuation")?.value).toMatchObject({ narrowed_candidate_count: 2 });
    f.setText("Nombor rujukan Q-2026-0007."); const response = await f.wire(4);
    const p = lastPacket(f);
    expect(p.evidence.find(e => e.id === "runtime:identity_continuation")?.value).toMatchObject({ narrowed_candidate_count: 1, reference_received: true, identity_verified: false });
    expect(p.person.identity_refs).toEqual([]); expect(p.available_actions).toEqual([]); expect(p.business.selected_quotation).toBeNull();
    expect(response.speech_text).toContain("Pengesahan pemilik tempahan dan nombor WhatsApp perlu dibuat dengan agensi melalui saluran rasmi");
    expect(response.speech_text).not.toContain("?"); expect(response.speech_text).not.toContain("29400");
    f.setText("Status tempahan tadi."); await f.wire(5);
    expect(lastPacket(f).evidence.find(e => e.id === "runtime:identity_continuation")?.value)
      .toMatchObject({ narrowed_candidate_count: 1, reference_received: true, identity_verified: false });
  });
  it("does not expose another tenant's reference or use it as a matching record", async () => {
    const f = await runtime(); await nameAnswer(f);
    await f.pg.query("INSERT INTO quotations(id,agency_id,lead_id,quotation_number) VALUES('88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999',$1,'Q-2026-9999')", [businessIds.lead]);
    f.setText("Q-2026-9999"); const result = await f.wire(4);
    expect(lastPacket(f).evidence.find(e => e.id === "runtime:identity_continuation")?.value).toMatchObject({ narrowed_candidate_count: 0, identity_verified: false });
    expect(result.speech_text).not.toMatch(/9999|\?/); expect(lastPacket(f).business.quotation_refs).toEqual([]);
  });
  it("does not trust model speech to verify a caller-stated name", async () => {
    const f = await runtime(); await f.wire(1); await f.wire(2); f.setText("Datuk Rizal.");
    f.setEngine(async ({packet}) => ({ decision: decisionFixture(packet,{spoken_response:"Tempahan sudah disahkan.",interaction_mode:"ANSWER"}), metadata:meta }));
    const result = await f.wire(3);
    expect(result.speech_text).not.toContain("Tempahan sudah disahkan"); expect(result.speech_text).toContain("rujukan sebut harga");
    expect(lastPacket(f).person.identity_refs).toEqual([]);
  });
  it.each(["unmatched name", "no stored reference"])("explains the exact required verification when there is %s", async scenario => {
    const f = await runtime(); await f.wire(1); await f.wire(2);
    if (scenario === "no stored reference") await f.pg.exec("DELETE FROM quotations");
    f.setText(scenario === "unmatched name" ? "Nama saya Orang Lain." : "Datuk Rizal.");
    const result = await f.wire(3);
    expect(result.speech_text).toContain("Pengesahan pemilik tempahan dan nombor WhatsApp perlu dibuat dengan agensi melalui saluran rasmi");
    expect(result.speech_text).not.toMatch(/\?|macam mana/); expect(lastPacket(f).person.identity_refs).toEqual([]);
  });
  it("does not repeat either answered question after the rolling caller/event window", async () => {
    const f = await runtime(); await nameAnswer(f); f.setText("Rujukannya Q-2026-0007."); await f.wire(4);
    f.setText("Status tempahan tadi.");
    for (let sequence = 5; sequence <= 18; sequence++) expect((await f.wire(sequence)).speech_text).not.toContain("?");
    const p = lastPacket(f); expect(p.current_call.caller_refs).toHaveLength(10);
    expect(p.person.identity_refs).toEqual([]); expect(p.evidence.find(e => e.id === "runtime:identity_continuation")?.value).toMatchObject({ name_received: true, reference_received: true });
  });
  it("reuses independent authoritative identity resolution without further identity questions", async () => {
    const f = await runtime(); await nameAnswer(f);
    // Only the isolated fixture is changed: simulate an agency resolving the duplicate contact independently.
    await f.pg.query("DELETE FROM leads WHERE id=$1", [duplicate]);
    f.setText("Status tempahan saya?");
    for (const sequence of [4,5,6]) {
      expect((await f.wire(sequence)).speech_text).not.toMatch(/nama penuh|pengesahan|rujukan.*\?/i);
      expect(lastPacket(f).person.identity_refs).toEqual([`leads:${businessIds.lead}:full_name`]);
      expect(lastPacket(f).uncertainties.some(u => u.id === "identity_unknown")).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("retains cancellation evidence even when the response abort wins before engine settlement", async () => {
    const f = await runtime(); await f.wire(1);
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    f.setEngine(async ({signal}) => { started(); return new Promise((_,reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true})); });
    const abort = new AbortController(); const pending = f.turn(2,abort.signal); await ready; abort.abort();
    expect(await pending).toMatchObject({ok:false,reason:"response_cancelled"}); await Promise.all(f.retained);
    const s = await f.snapshot();
    expect(s.events.some((e:{kind:string;sequence:number}) => e.kind === "proposal" && e.sequence === 2)).toBe(false);
    expect(s.events.find((e:{kind:string;sequence:number}) => e.kind === "telemetry" && e.sequence === 2).payload.engine_failure)
      .toMatchObject({failure_class:"REQUEST_CANCELLED",failure_stage:"engine_wait",cancelled:true});
    expect(s.callers).toHaveLength(1);
  });
  it("retains a response deadline as a timeout while waiting for the engine, not caller cancellation", async () => {
    const f = await runtime(); await f.wire(1);
    f.setEngine(async ({signal}) => new Promise((_,reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true})));
    expect(await f.turn(2, new AbortController().signal, Date.now() - 18400)).toMatchObject({ok:false,reason:"processing_timeout"});
    await Promise.all(f.retained);
    const s = await f.snapshot();
    expect(s.events.find((e:{kind:string;sequence:number}) => e.kind === "telemetry" && e.sequence === 2).payload.engine_failure)
      .toMatchObject({failure_class:"PROVIDER_TIMEOUT",failure_stage:"engine_wait",cancelled:false,timed_out:true});
    expect(s.events.some((e:{kind:string;sequence:number}) => e.kind === "proposal" && e.sequence === 2)).toBe(false);
  });
});
