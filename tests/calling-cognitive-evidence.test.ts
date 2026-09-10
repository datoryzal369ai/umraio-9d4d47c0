import { afterAll, beforeAll, expect, it } from "vitest";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";
import { binding, bridgeDatabase, digest, receivedAt } from "./helpers/calling-bridge-db";
let store: Awaited<ReturnType<typeof bridgeDatabase>>;
const base = bindingArgs(binding);
let generation: string;
beforeAll(async () => { store = await bridgeDatabase(); const lease = await store.rpc("calling_bridge_begin", { ...base, p_sequence: 1, p_greeting: true, p_received_at: receivedAt, p_request_digest: digest }); generation = lease.generation; });
afterAll(async () => { await store?.pg.close(); });

it("records proposal and handoff separately, requiring playback evidence for delivered history", async () => {
  const event = { ...base, p_sequence: 1, p_generation: generation, p_revision: 1, p_payload: { text: "Assalamualaikum", closing_question: false } };
  await store.rpc("calling_bridge_record", { ...event, p_kind: "proposal" });
  let snapshot = await store.rpc("calling_bridge_snapshot", base);
  expect(snapshot.events.map((e: {kind:string}) => e.kind)).toEqual(["proposal"]);
  await expect(store.rpc("calling_bridge_record", { ...event, p_kind: "playback_complete" })).rejects.toThrow("calling_evidence_kind_forbidden");
  await store.rpc("calling_bridge_record", { ...event, p_kind: "handoff" });
  expect((await store.rpc("calling_bridge_observe_media", { ...base, p_sequence: 2, p_metrics: { prev_sequence: 1, tts_ms: 2000 } })).ok).toBe(false);
  expect((await store.rpc("calling_bridge_observe_media", { ...base, p_sequence: 1, p_metrics: { prev_sequence: 1, playback_complete_ms: 3000 } })).ok).toBe(false);
  await store.rpc("calling_bridge_observe_media", { ...base, p_sequence: 2, p_metrics: { prev_sequence: 1, playback_complete_ms: 3000 } });
  snapshot = await store.rpc("calling_bridge_snapshot", base);
  expect(snapshot.events.filter((e: {kind:string}) => e.kind === "playback_complete")).toHaveLength(1);
  await store.rpc("calling_bridge_observe_media", { ...base, p_sequence: 2, p_metrics: { prev_sequence: 1, playback_complete_ms: 3000 } });
  expect((await store.rpc("calling_bridge_snapshot", base)).events.filter((e: {kind:string}) => e.kind === "playback_complete")).toHaveLength(1);
});
it("fences a superseded generation and derives terminal state only from actual session evidence", async () => {
  await store.rpc("calling_bridge_begin", { ...base, p_sequence: 2, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
  const stale = await store.rpc("calling_bridge_record", { ...base, p_sequence: 1, p_generation: generation, p_revision: 1, p_kind: "acknowledgement", p_payload: { text: "stale" } });
  expect(stale).toMatchObject({ ok: false, reason: "stale_turn" });
  await store.pg.exec("UPDATE whatsapp_call_sessions SET status='terminated'");
  const snapshot = await store.rpc("calling_bridge_snapshot", base);
  expect(snapshot.live).toBe(false); expect(snapshot.closing_state).toBe("terminal");
  expect(snapshot.events.filter((e: {kind:string}) => e.kind === "playback_complete")).toHaveLength(1);
});
