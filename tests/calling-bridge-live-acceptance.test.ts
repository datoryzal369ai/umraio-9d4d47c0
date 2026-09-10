/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { binding, bridgeDatabase, digest, receivedAt } from "./helpers/calling-bridge-db";
import { bridgeBusiness, businessIds } from "./helpers/calling-bridge-business";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";

const path = "supabase/migrations/20260910172000_calling_cognitive_bridge_live_acceptance.sql";
const migration = readFileSync(path, "utf8");
const functions = ["calling_bridge_begin", "calling_bridge_snapshot", "calling_bridge_persist_caller",
  "calling_bridge_record", "calling_bridge_output", "calling_bridge_action"];
const base = bindingArgs(binding);
const admission = (sequence = 1, greeting = true) => ({ ...base, p_sequence: sequence, p_greeting: greeting,
  p_received_at: receivedAt, p_request_digest: digest });
const output = { text: "Assalamualaikum. Saya RAIŌ, pembantu AI.", next_state: "active", greeting: true, language: "ms" };
type Lease = { generation: string; revision: number };
const owner = (lease: Lease, sequence = 1) => ({ ...base, p_sequence: sequence,
  p_generation: lease.generation, p_revision: lease.revision });
const persist = (lease: Lease, sequence = 2) => ({ ...base, p_sequence: sequence, p_generation: lease.generation,
  p_transcript: "Saya nak tanya quotation saya.", p_asr_completed_at: receivedAt, p_language: "ms", p_duration_ms: 1000 });

it("reproduces the released predicate rejecting an accepted meta_pre_accepted greeting before repair", async () => {
  const old = await bridgeDatabase({ liveAcceptance: false });
  try {
    await old.pg.query("UPDATE whatsapp_call_sessions SET status='meta_pre_accepted',meta_accepted_at=$1 WHERE id=$2", [receivedAt, binding.sessionId]);
    expect(await old.rpc("calling_bridge_begin", admission())).toEqual({ state: "terminal", can_respond: false });
    expect((await old.pg.query("SELECT count(*)::int n FROM calling_bridge_sessions")).rows[0].n).toBe(0);
  } finally { await old.pg.close(); }
});

it("replaces only the six live-status lists and preserves owners, ACLs, RLS, data and migration replay", async () => {
  const old = await bridgeDatabase({ liveAcceptance: false });
  try {
    const objectState = async () => (await old.pg.query(`SELECT jsonb_build_object(
      'tables',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
      'functions',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig) ORDER BY p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
      'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d),
      'policies',(SELECT jsonb_agg(to_jsonb(p)) FROM pg_policy p),
      'sessions',(SELECT jsonb_agg(to_jsonb(s)) FROM whatsapp_call_sessions s)
    ) state`)).rows[0].state;
    const definitions = async () => (await old.pg.query("SELECT proname,prosrc FROM pg_proc WHERE proname LIKE 'calling_bridge_%' ORDER BY proname")).rows;
    const before = await objectState();
    const bodies = await definitions();
    await old.pg.exec(migration);
    expect(await objectState()).toEqual(before);
    const after = await definitions();
    expect(after).toHaveLength(bodies.length);
    for (const fn of bodies) {
      const expected = functions.includes(fn.proname)
        ? fn.prosrc.replace("('answer_requested','media_negotiating','answered')", "('answer_requested','media_negotiating','meta_pre_accepted','answered')")
        : fn.prosrc;
      expect(after.find((x: any) => x.proname === fn.proname).prosrc).toBe(expected);
      if (functions.includes(fn.proname)) expect(expected).not.toBe(fn.prosrc);
    }
    expect(migration.match(/CREATE OR REPLACE FUNCTION public\.calling_bridge_/g)).toHaveLength(6);
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|GRANT|REVOKE|CREATE TABLE|ALTER TABLE|ALTER DEFAULT PRIVILEGES)\b/);
    await old.pg.exec(migration);
    expect(await definitions()).toEqual(after);
    expect(await objectState()).toEqual(before);
  } finally { await old.pg.close(); }
});

describe("accepted pre-media lifecycle through governed Bridge RPCs", () => {
  let f: Awaited<ReturnType<typeof bridgeBusiness>>;
  beforeEach(async () => {
    f = await bridgeBusiness();
    await f.pg.query("UPDATE whatsapp_call_sessions SET status='meta_pre_accepted',meta_accepted_at=$1 WHERE id=$2", [receivedAt, binding.sessionId]);
  });
  afterEach(async () => { await f?.pg.close(); });
  async function service<T>(work: () => Promise<T>): Promise<T> {
    await f.pg.exec("SET ROLE service_role");
    try { return await work(); } finally { await f.pg.exec("RESET ROLE"); }
  }

  it("admits, snapshots, records, prepares and hands off one greeting without promoting status to answered", async () => {
    await service(async () => {
      const lease = await f.rpc("calling_bridge_begin", admission());
      expect(lease).toMatchObject({ state: "admitted", can_respond: true, revision: 1 });
      expect((await f.rpc("calling_bridge_snapshot", base))).toMatchObject({ live: true, current_sequence: 1, generation: lease.generation });
      expect(await f.rpc("calling_bridge_record", { ...owner(lease), p_kind: "acknowledgement", p_payload: { text: "Baik." } })).toMatchObject({ ok: true });
      expect(await f.rpc("calling_bridge_output", { ...owner(lease), p_payload: output })).toMatchObject({ ok: true });
      expect(await f.rpc("calling_bridge_record", { ...owner(lease), p_kind: "handoff", p_payload: {} })).toMatchObject({ ok: true });
      const state = await f.rpc("calling_bridge_snapshot", base);
      expect(state.events.filter((e: any) => e.kind === "proposal")).toHaveLength(1);
      expect(state.events.filter((e: any) => e.kind === "handoff")).toHaveLength(1);
      expect(state.events.some((e: any) => e.kind === "playback_complete")).toBe(false);
      expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_sessions WHERE session_id=$1", [binding.sessionId])).rows[0].n).toBe(1);
    });
    expect((await f.pg.query("SELECT status,meta_accepted_at,disclosure_spoken FROM whatsapp_call_sessions WHERE id=$1", [binding.sessionId])).rows[0])
      .toMatchObject({ status: "meta_pre_accepted", disclosure_spoken: true });
  });

  it("preserves caller input and permits governed action claim/dispatch while real Meta acceptance is present", async () => {
    await service(async () => {
      await f.rpc("calling_bridge_begin", admission());
      const lease = await f.rpc("calling_bridge_begin", admission(2, false));
      expect(await f.rpc("calling_bridge_persist_caller", persist(lease))).toMatchObject({ can_respond: true, turn: { transcript: persist(lease).p_transcript } });
      const action = { ...owner(lease, 2), p_quotation: businessIds.quotation };
      expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "claim" })).toMatchObject({ ok: true });
      expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "claim" })).toMatchObject({ ok: false, reason: "already_claimed" });
      expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "dispatch" })).toMatchObject({ ok: true });
      expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "dispatch" })).toMatchObject({ ok: false, reason: "dispatch_already_claimed" });
      expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "finish", p_result: { outcome: "timeout" } }))
        .toMatchObject({ ok: true, outcome: "outcome_unknown" });
      expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "claim" })).toMatchObject({ ok: false, reason: "already_claimed" });
      await expect(f.rpc("calling_bridge_action", { ...action, p_generation: "77777777-7777-4777-8777-777777777777", p_operation: "finish", p_result: { outcome: "verified_failure" } }))
        .rejects.toMatchObject({ code: "42501", message: "calling_action_owner_mismatch" });
    });
  });

  const denied = [
    { status: "meta_pre_accepted", accepted: false },
    ...["terminated", "failed", "completed", "rejected", "missed", "ringing"].map(status => ({ status, accepted: true })),
  ];
  it.each(denied)("denies new admission for $status / acceptance=$accepted", async ({ status, accepted }) => {
    await f.pg.query("UPDATE whatsapp_call_sessions SET status=$1,meta_accepted_at=$2 WHERE id=$3", [status, accepted ? receivedAt : null, binding.sessionId]);
    expect(await service(() => f.rpc("calling_bridge_begin", admission()))).toMatchObject({ state: "terminal", can_respond: false });
    expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_sessions")).rows[0].n).toBe(0);
    expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_turns")).rows[0].n).toBe(0);
  });

  it.each(denied)("cannot speak or execute after an admitted call becomes $status / acceptance=$accepted", async ({ status, accepted }) => {
    const lease = await f.rpc("calling_bridge_begin", admission(2, false));
    // New non-greeting calls stay on the legacy path; first pin at the greeting.
    expect(lease.state).toBe("legacy");
    await f.rpc("calling_bridge_begin", admission());
    const admitted = await f.rpc("calling_bridge_begin", admission(2, false));
    const action = { ...owner(admitted, 2), p_quotation: businessIds.quotation };
    expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "claim" })).toMatchObject({ ok: true });
    await f.pg.query("UPDATE whatsapp_call_sessions SET status=$1,meta_accepted_at=$2 WHERE id=$3", [status, accepted ? receivedAt : null, binding.sessionId]);
    await service(async () => {
      expect((await f.rpc("calling_bridge_snapshot", base)).live).toBe(false);
      expect(await f.rpc("calling_bridge_begin", admission(3, false))).toMatchObject({ state: "terminal", can_respond: false });
      expect(await f.rpc("calling_bridge_persist_caller", persist(admitted))).toMatchObject({ can_respond: false, turn: { transcript: persist(admitted).p_transcript } });
      expect(await f.rpc("calling_bridge_output", { ...owner(admitted, 2), p_payload: output })).toMatchObject({ ok: false, reason: "stale_turn" });
      expect(await f.rpc("calling_bridge_record", { ...owner(admitted, 2), p_kind: "acknowledgement", p_payload: {} })).toMatchObject({ ok: false, reason: "stale_turn" });
      expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "dispatch" })).toMatchObject({ ok: false, reason: "stale_turn" });
      expect(await f.rpc("calling_bridge_action", { ...action, p_quotation: "77777777-7777-4777-8777-777777777777", p_operation: "claim" }))
        .toMatchObject({ ok: false, reason: "stale_turn" });
    });
    expect((await f.pg.query("SELECT status FROM whatsapp_call_sessions WHERE id=$1", [binding.sessionId])).rows[0].status).toBe(status);
  });

  function argsFor(name: string, lease: Lease) {
    switch (name) {
      case "calling_bridge_begin": return admission(3, false);
      case "calling_bridge_snapshot": return base;
      case "calling_bridge_persist_caller": return persist(lease);
      case "calling_bridge_record": return { ...owner(lease, 2), p_kind: "acknowledgement", p_payload: {} };
      case "calling_bridge_output": return { ...owner(lease, 2), p_payload: output };
      case "calling_bridge_action": return { ...owner(lease, 2), p_quotation: businessIds.quotation, p_operation: "claim" };
      default: throw new Error("fixture_function");
    }
  }
  it.each(functions)("%s preserves agency/session/call/gateway binding at the newly live lifecycle state", async name => {
    await f.rpc("calling_bridge_begin", admission());
    const lease = await f.rpc("calling_bridge_begin", admission(2, false));
    for (const [key, value] of Object.entries({ p_agency: "77777777-7777-4777-8777-777777777777",
      p_session: "88888888-8888-4888-8888-888888888888", p_call: "wrong-call", p_gateway: "wrong-gateway" })) {
      await service(async () => {
        await expect(f.rpc(name, { ...argsFor(name, lease), [key]: value })).rejects.toMatchObject({ code: "42501", message: "calling_binding_mismatch" });
      });
    }
  });

  it.each(["revision", "generation", "sequence"])("denies stale %s at output, acknowledgement and action boundaries", async mismatch => {
    const lease = await f.rpc("calling_bridge_begin", admission());
    const stale = { ...owner(lease), ...(mismatch === "revision" ? { p_revision: lease.revision + 1 }
      : mismatch === "generation" ? { p_generation: "77777777-7777-4777-8777-777777777777" } : { p_sequence: 2 }) };
    await service(async () => {
      expect(await f.rpc("calling_bridge_output", { ...stale, p_payload: output })).toMatchObject({ ok: false, reason: "stale_turn" });
      expect((await f.rpc("calling_bridge_record", { ...stale, p_kind: "acknowledgement", p_payload: {} })).ok).toBe(false);
      expect(await f.rpc("calling_bridge_action", { ...stale, p_quotation: businessIds.quotation, p_operation: "claim" })).toMatchObject({ ok: false, reason: "stale_turn" });
    });
  });

  it("admits a greeting exactly once under 20 duplicate requests and rejects conflicting retries", async () => {
    await service(async () => {
      const replies = await Promise.all(Array.from({ length: 20 }, () => f.rpc("calling_bridge_begin", admission())));
      expect(replies.filter(r => r.state === "admitted" && r.can_respond)).toHaveLength(1);
      expect(replies.filter(r => r.state === "duplicate" && !r.can_respond)).toHaveLength(19);
      await expect(f.rpc("calling_bridge_begin", { ...admission(), p_request_digest: "b".repeat(64) })).rejects.toMatchObject({ code: "23505" });
      expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_sessions")).rows[0].n).toBe(1);
      expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_turns")).rows[0].n).toBe(1);
    });
  });

  it("retains out-of-order caller evidence without reviving superseded speech or execution", async () => {
    await f.rpc("calling_bridge_begin", admission());
    const latest = await f.rpc("calling_bridge_begin", admission(3, false));
    const late = await f.rpc("calling_bridge_begin", admission(2, false));
    expect(late.can_respond).toBe(false);
    expect(await f.rpc("calling_bridge_persist_caller", persist(late))).toMatchObject({ can_respond: false });
    expect(await f.rpc("calling_bridge_persist_caller", persist(latest, 3))).toMatchObject({ can_respond: true });
    expect(await f.rpc("calling_bridge_output", { ...owner(late, 2), p_payload: output })).toMatchObject({ ok: false, reason: "stale_turn" });
    expect(await f.rpc("calling_bridge_action", { ...owner(late, 2), p_quotation: businessIds.quotation, p_operation: "claim" }))
      .toMatchObject({ ok: false, reason: "stale_turn" });
    expect((await f.rpc("calling_bridge_snapshot", base)).callers).toHaveLength(2);
  });

  it("commits one farewell and permits only fresh caller speech to supersede pending closing", async () => {
    const lease = await f.rpc("calling_bridge_begin", admission());
    const goodbye = { ...owner(lease), p_payload: { text: "Terima kasih. Assalamualaikum.", next_state: "farewell_committed", language: "ms" } };
    const first = await f.rpc("calling_bridge_output", goodbye);
    expect(first).toMatchObject({ ok: true }); expect(first.farewell_id).toBeTruthy();
    expect(await f.rpc("calling_bridge_output", goodbye)).toMatchObject({ ok: false, reason: "stale_turn" });
    expect(await f.rpc("calling_bridge_begin", admission(2))).toMatchObject({ state: "terminal", can_respond: false });
    expect(await f.rpc("calling_bridge_action", { ...owner(lease), p_quotation: businessIds.quotation, p_operation: "claim" }))
      .toMatchObject({ ok: false, reason: "stale_turn" });
    expect(await f.rpc("calling_bridge_record", { ...owner(lease), p_kind: "handoff", p_payload: {} })).toMatchObject({ ok: true });
    const resumed = await f.rpc("calling_bridge_begin", admission(2, false));
    expect(resumed).toMatchObject({ state: "admitted", can_respond: true });
    expect(await f.rpc("calling_bridge_output", goodbye)).toMatchObject({ ok: false, reason: "stale_turn" });
    expect((await f.rpc("calling_bridge_snapshot", base)).farewell_id).toBeNull();
  });
});
