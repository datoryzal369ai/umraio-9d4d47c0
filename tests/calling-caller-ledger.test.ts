import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bindingArgs, retainCallerTurn } from "../src/lib/calls/caller-turn-ledger.server";
import { callingLifetime, retainBounded, withinCallingBudget } from "../src/lib/calls/calling-lifetime.server";
import { binding, bridgeDatabase, digest, receivedAt } from "./helpers/calling-bridge-db";

describe("Calling durable caller ledger — actual PostgreSQL migration", () => {
  let store: Awaited<ReturnType<typeof bridgeDatabase>>;
  let sequence = 1;
  const base = () => ({ ...bindingArgs(binding), p_sequence: ++sequence });
  beforeAll(async () => {
    store = await bridgeDatabase();
    await store.rpc("calling_bridge_begin", { ...bindingArgs(binding), p_sequence: 1, p_greeting: true, p_received_at: receivedAt, p_request_digest: digest });
  });
  afterAll(async () => { await store?.pg.close(); });

  it.each(Array.from({ length: 20 }, (_, i) => i))("retains successful ASR exactly once despite assistant cancellation %i", async () => {
    const response = new AbortController();
    const retained: Promise<unknown>[] = [];
    const seq = ++sequence;
    const result = await retainCallerTurn({ db: store.db, binding, sequence: seq, greeting: false, receivedAt, durationMs: 1500, requestDigest: digest,
      lifetime: { retain: task => { retained.push(task); } }, asr: async signal => {
        response.abort(new DOMException("barge in", "AbortError"));
        expect(signal.aborted).toBe(false);
        return { text: ` Exact caller speech ${seq} `, durationSeconds: null, language: "ms", confidence: "unknown", provider: "test", model: "unchanged" };
      } });
    await Promise.all(retained);
    expect(response.signal.aborted).toBe(true);
    expect(result.turn?.transcript).toBe(` Exact caller speech ${seq} `);
    expect(result.turn?.confidence).toBe("unknown");
    const retry = await store.rpc("calling_bridge_begin", { ...bindingArgs(binding), p_sequence: seq, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
    expect(retry.state).toBe("duplicate"); expect(retry.can_respond).toBe(false);
    expect(retry.turn.id).toBe(result.turn?.id);
    const count = await store.pg.query("SELECT count(*)::int AS n FROM calling_caller_turns WHERE sequence=$1", [seq]);
    expect(count.rows[0].n).toBe(1);
  });

  it("preserves out-of-order input without granting stale response ownership", async () => {
    const older = base(); const newer = base();
    const newLease = await store.rpc("calling_bridge_begin", { ...newer, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
    const oldLease = await store.rpc("calling_bridge_begin", { ...older, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
    expect(oldLease.can_respond).toBe(false);
    for (const [input, lease, text, eligible] of [[older, oldLease, "late caller evidence", false], [newer, newLease, "new caller evidence", true]] as const) {
      const saved = await store.rpc("calling_bridge_persist_caller", { ...input, p_generation: lease.generation, p_transcript: text,
        p_asr_completed_at: receivedAt, p_language: "ms", p_duration_ms: 1200 });
      expect(saved.can_respond).toBe(eligible); expect(saved.turn.transcript).toBe(text);
    }
  });

  it("does not overwrite a sequence or transcript on conflicting retry", async () => {
    const args = base();
    const lease = await store.rpc("calling_bridge_begin", { ...args, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
    await expect(store.rpc("calling_bridge_begin", { ...args, p_greeting: false, p_received_at: receivedAt, p_request_digest: "b".repeat(64) })).rejects.toThrow("calling_sequence_conflict");
    const persist = { ...args, p_generation: lease.generation, p_transcript: "original", p_asr_completed_at: receivedAt, p_language: "ms", p_duration_ms: 500 };
    const results = await Promise.all([store.rpc("calling_bridge_persist_caller", persist), store.rpc("calling_bridge_persist_caller", persist)]);
    expect(results[0].turn.id).toBe(results[1].turn.id);
    await expect(store.rpc("calling_bridge_persist_caller", { ...persist, p_transcript: "replacement" })).rejects.toThrow("calling_transcript_conflict");
    await expect(store.pg.exec("UPDATE calling_caller_turns SET transcript='changed'")).rejects.toThrow("calling_append_only");
    await expect(store.pg.exec("DELETE FROM calling_caller_turns")).rejects.toThrow("calling_append_only");
  });

  it("rejects cross-tenant/session binding and unauthenticated ledger access", async () => {
    await expect(store.rpc("calling_bridge_begin", { ...base(), p_agency: "33333333-3333-4333-8333-333333333333", p_greeting: false, p_received_at: receivedAt, p_request_digest: digest })).rejects.toThrow("calling_binding_mismatch");
    for (const role of ["anon", "authenticated"]) {
      await store.pg.exec(`SET ROLE ${role}`);
      await expect(store.pg.exec("SELECT * FROM calling_caller_turns")).rejects.toThrow(/permission denied/);
      await expect(store.rpc("calling_bridge_begin", { ...bindingArgs(binding), p_sequence: 99, p_greeting: true, p_received_at: receivedAt, p_request_digest: digest })).rejects.toThrow(/permission denied/);
      await store.pg.exec("RESET ROLE");
    }
  });

  it("retains admitted ASR after teardown without reopening or executing", async () => {
    const args = base();
    const lease = await store.rpc("calling_bridge_begin", { ...args, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
    await store.pg.exec("UPDATE whatsapp_call_sessions SET status='terminated'");
    const saved = await store.rpc("calling_bridge_persist_caller", { ...args, p_generation: lease.generation, p_transcript: "completed before teardown",
      p_asr_completed_at: receivedAt, p_language: "ms", p_duration_ms: 1000 });
    expect(saved.turn.transcript).toBe("completed before teardown"); expect(saved.can_respond).toBe(false);
    const next = await store.rpc("calling_bridge_begin", { ...base(), p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
    expect(next.state).toBe("terminal");
    const status = await store.pg.query("SELECT status FROM whatsapp_call_sessions");
    expect(status.rows[0].status).toBe("terminated");
  });
});

describe("Calling bounded request lifetime", () => {
  it("fails closed when the Worker does not expose retention", () => {
    expect(() => callingLifetime(new Request("https://calling.test"))).toThrow("calling_durable_lifetime_unavailable");
  });
  it("aborts actual I/O, settles retained work and clears timers", async () => {
    vi.useFakeTimers();
    try {
      const retained: Promise<unknown>[] = [];
      let ioAborted = false;
      const result = retainBounded({ retain: p => { retained.push(p); } }, 200, signal => withinCallingBudget(signal, 1000, ioSignal => new Promise((_, reject) => {
        ioSignal.addEventListener("abort", () => { ioAborted = true; reject(ioSignal.reason); }, { once: true });
      })));
      const rejected = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(200); await rejected; await Promise.all(retained);
      expect(ioAborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
