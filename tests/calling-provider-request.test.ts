import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { callingGenerationSchema, type CognitivePacket } from "../src/lib/calls/cognitive-bridge.contract";
import { packetFixture, decisionFixture } from "./helpers/calling-cognitive-fixtures";
import { validateCallingDecision } from "../src/lib/calls/call-decision-policy.core";
import { z } from "zod";
import { handleCognitiveVoiceTurn } from "../src/lib/calls/cognitive-bridge.server";
import { callingContractRecovery } from "../src/lib/calls/call-speech-claims.core";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";
import { bridgeBusiness, businessIds } from "./helpers/calling-bridge-business";
import { binding } from "./helpers/calling-bridge-db";

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/lib/ai/config.server", () => ({ getAiConfig: () => ({ provider: "openai", model: "gpt-4.1", timeouts: { reasoning: 15000 } }) }));
vi.mock("../src/lib/ai/providers.server", async () => {
  const { createOpenAI } = await import("@ai-sdk/openai");
  return { getProviderAdapter: () => ({ model: () => createOpenAI({ apiKey: "synthetic-offline-only", fetch: fixture.fetch }).responses("gpt-4.1"),
    requestOptions: () => ({ openai: { store: false } }) }) };
});
import { currentCallingEngine } from "../src/lib/calls/cognitive-engine.server";

// This is an OFFLINE Responses API conformance fixture, not a captured provider receipt.
// Requirement: https://developers.openai.com/api/docs/guides/structured-outputs#all-fields-must-be-required
function missingRequired(schema: any, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const missing = schema.type === "object" ? Object.keys(schema.properties ?? {}).filter(k => !schema.required?.includes(k)).map(k => `${path}${k}`) : [];
  return [...missing, ...Object.entries(schema.properties ?? {}).flatMap(([k,v]) => missingRequired(v, `${path}${k}.`)),
    ...missingRequired(schema.items, `${path}items.`), ...(schema.anyOf ?? []).flatMap((s: unknown) => missingRequired(s,path))];
}
const wire: any[] = [];
function provider(p: CognitivePacket, decision = decisionFixture(p)) {
  const onlyQuote = (m: {evidence_quote: string}) => ({ evidence_quote: m.evidence_quote });
  const output = { ...decision, clarification: decision.clarification ?? null, memory_update: {
    objective: decision.memory_update.objective ? onlyQuote(decision.memory_update.objective) : null,
    corrections: decision.memory_update.corrections.map(onlyQuote), open_questions: decision.memory_update.open_questions.map(onlyQuote) } };
  fixture.fetch.mockImplementation(async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); wire.push(body);
    const missing = missingRequired(body.text?.format?.schema);
    if (missing.length) return Response.json({ error: { type: "invalid_request_error", code: "invalid_json_schema", param: "text.format.schema",
      message: `Invalid schema for response_format 'response': 'required' must include every key in properties. Missing '${missing[0]}'.` } }, { status: 400 });
    return Response.json({ id: "resp_synthetic", created_at: 1789136400, model: "gpt-4.1", object: "response", status: "completed",
      output: [{ id: "msg_synthetic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
  });
  return output;
}
afterEach(() => { fixture.fetch.mockReset(); wire.length = 0; });

describe("Calling Responses API request conformance (offline, real SDK)", () => {
  it("reproduces the published optional-clarification schema rejection through the actual SDK serializer", async () => {
    const p = packetFixture(); provider(p);
    const model = createOpenAI({ apiKey: "synthetic-offline-only", fetch: fixture.fetch }).responses("gpt-4.1");
    const error = await generateText({ model, providerOptions: { openai: { store: false } }, prompt: JSON.stringify(p),
      output: Output.object({ schema: callingGenerationSchema(p) }), maxRetries: 0 }).catch(e => e);
    expect(error).toMatchObject({ name: "AI_APICallError", statusCode: 400, data: { error: { code: "invalid_json_schema", param: "text.format.schema" } } });
    expect(wire[0]).toMatchObject({ model: "gpt-4.1", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(missingRequired(wire[0].text.format.schema)).toEqual(["clarification"]);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
  it("sends one conforming request and passes the real SDK decision to the unchanged semantic contract", async () => {
    const p = packetFixture(); const expected = provider(p);
    const result = await currentCallingEngine.decide({ packet: p, deadline: Date.now() + 15000, signal: new AbortController().signal });
    expect(missingRequired(wire[0].text.format.schema)).toEqual([]);
    expect(wire[0].text.format.strict).toBe(true); expect(wire[0].model).toBe("gpt-4.1"); expect(wire[0].store).toBe(false);
    expect(wire[0].tools ?? []).toEqual([]);
    const publishedSchema = z.toJSONSchema(callingGenerationSchema(p), { target: "draft-7", io: "input" });
    const { required: oldRequired, ...oldShape } = publishedSchema;
    const { required: newRequired, ...newShape } = wire[0].text.format.schema;
    expect(newShape).toEqual(oldShape);
    expect([...newRequired].sort()).toEqual([...(oldRequired as string[]), "clarification"].sort());
    expect(result.decision).toEqual(expected);
    expect(validateCallingDecision(result.decision, p, { revision: 2, generation: "generation-2", live: true, cancelled: false }).ok).toBe(true);
    expect(result.metadata.fallback).toBe(false); expect(result.metadata.returned_model).toBe("gpt-4.1");
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
  it("replays the latest Founder utterance through PostgreSQL, the real engine/SDK and semantic admission", async () => {
    const f = await bridgeBusiness(); const retained: Promise<unknown>[] = [];
    try {
      await f.pg.query("UPDATE leads SET full_name='Datuk Rizal',preferred_language='ms' WHERE id=$1",[businessIds.lead]);
      await f.pg.query("INSERT INTO leads(id,agency_id,phone,full_name) VALUES('77777777-7777-4777-8777-777777777777',$1,'60123456789','Ryzal Jamaludin')",[binding.agencyId]);
      await f.pg.query("UPDATE conversations SET external_id='60123456789' WHERE id=$1",[businessIds.conversation]);
      await f.pg.query("INSERT INTO messages(id,agency_id,conversation_id,sender,body) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2,'customer',$3)",
        [binding.agencyId,businessIds.conversation,"Nama saya Dato' Rizal. Tempahan umrah PRIVATE_PAYMENT_DETAILS"]);
      const transcript = "Saya Dato' Rizal, saya nak cek tempahan saya lah.";
      let packet: CognitivePacket | undefined;
      const present = vi.fn(async (text: string) => ({ text, replyOggBase64: null, voiceId: "unchanged", languageBoost: "Malay" }));
      const decide = vi.fn(async (input: Parameters<typeof currentCallingEngine.decide>[0]) => {
        packet = input.packet; provider(packet, callingContractRecovery(packet)); return currentCallingEngine.decide(input);
      });
      const args = { db: f.db, binding, callerPhone: "60123456789", language: "ms-MY", agencyName: "Synthetic", disclosureSpoken: false,
        voiceId: "unchanged", languageBoost: () => "Malay", present, engine: { decide },
        lifetime: { retain: (p: Promise<unknown>) => { retained.push(p); } },
        asr: async () => ({ text: transcript, language: "ms", durationSeconds: 4.52, confidence: "unknown" as const, provider: "fixture", model: "fixture" }) };
      const turn = (sequence: number) => handleCognitiveVoiceTurn({ ...args, receivedAt: Date.now(), signal: new AbortController().signal,
        payload: { call_id: binding.callId, sequence, kind: sequence === 1 ? "greeting" : "utterance", duration_ms: 4520,
          audio_ogg_base64: sequence === 1 ? null : btoa("synthetic-audio"), ...(sequence === 2 ? { media_metrics: { prev_sequence: 1, playback_complete_ms: 1000 } } : {}) } });
      await turn(1); const result = await turn(2); await Promise.all(retained);
      expect(result).toMatchObject({ ok: true, endCall: false,
        text: "Dato', nombor WhatsApp ini ada sejarah perbualan dengan kami. Untuk teruskan pengesahan tempahan, Apakah nombor rujukan sebut harga yang diterima daripada agensi?" });
      const snapshot = await f.rpc("calling_bridge_snapshot", bindingArgs(binding));
      const proposal = snapshot.events.find((e: any) => e.kind === "proposal" && e.sequence === 2).payload;
      expect(proposal).toMatchObject({ engine_failure: null, failure_classification: null, recovery: null, contract_repair: null,
        response_classification: "GENUINE_CLARIFICATION_REQUIRED", decision: { interaction_mode: "CLARIFY" },
        identity_continuation: { narrowed_ids: [businessIds.lead], step: "reference" } });
      expect(snapshot.callers[0].transcript).toBe(transcript); expect(snapshot.memory.objective.text).toBe(transcript);
      expect(packet!.person.identity_refs).toEqual([]); expect(packet!.business.quotation_refs).toEqual([]); expect(packet!.available_actions).toEqual([]);
      expect(JSON.stringify(packet)).not.toContain("PRIVATE_PAYMENT_DETAILS");
      expect(fixture.fetch).toHaveBeenCalledTimes(1); expect(decide).toHaveBeenCalledTimes(1); expect(present).toHaveBeenCalledTimes(2);
      const telemetry = snapshot.events.find((e: any) => e.kind === "telemetry" && e.sequence === 2).payload;
      expect(telemetry.engine.returned_model).toBe("gpt-4.1"); expect(telemetry.timings.policy_end).toBeGreaterThanOrEqual(telemetry.timings.policy_start);
      process.stdout.write(JSON.stringify({ offline_engine_ms: telemetry.engine.latency_ms, worker_ms: telemetry.timings.response_complete - telemetry.timings.received, model_calls: 1 }) + "\n");
    } finally { await Promise.all(retained); await f.pg.close(); }
  });
});
