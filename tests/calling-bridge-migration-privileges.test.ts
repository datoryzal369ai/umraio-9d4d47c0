/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bridgeTestRequire, binding, digest, receivedAt } from "./helpers/calling-bridge-db";

const migration = readFileSync("supabase/migrations/20260910170000_calling_cognitive_bridge_v1.sql", "utf8");
const marker = "-- Normalize only the new Bridge objects: deployment defaults may grant direct writes.";
const [original, repair] = migration.split(marker);
const originalMigration = original + "COMMIT;\n";
const repairTransaction = "BEGIN;\n" + repair;
const tables = ["calling_bridge_sessions", "calling_bridge_turns", "calling_caller_turns", "calling_bridge_events", "calling_bridge_actions"];
const entrypoints = ["calling_bridge_begin", "calling_bridge_persist_caller", "calling_bridge_snapshot", "calling_bridge_record", "calling_bridge_observe_media", "calling_bridge_action", "calling_bridge_output"];
const helpers = ["calling_bridge_immutable", "calling_bridge_project"];
const deniedRoles = ["anon", "authenticated", "sandbox_exec", "bridge_unprivileged"];
const otherAgency = "77777777-7777-4777-8777-777777777777";
const otherSession = "88888888-8888-4888-8888-888888888888";
const quotation = "55555555-5555-4555-8555-555555555555";
const message = "99999999-9999-4999-8999-999999999999";
const conversation = "44444444-4444-4444-8444-444444444444";
const base = { p_agency: binding.agencyId, p_session: binding.sessionId, p_call: binding.callId, p_gateway: binding.gatewaySessionId };

async function database(repaired = true) {
  const { PGlite } = bridgeTestRequire("@electric-sql/pglite");
  const pg = new PGlite();
  // Actual production defaults, including the extra platform reader/writer.
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE sandbox_exec BYPASSRLS; CREATE ROLE bridge_unprivileged;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT ON TABLES TO sandbox_exec;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO sandbox_exec;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
    CREATE TABLE agencies(id uuid PRIMARY KEY);
    CREATE TABLE whatsapp_call_sessions(id uuid PRIMARY KEY,agency_id uuid,call_id text,gateway_session_id text,
      meta_accepted_at timestamptz,status text,transcript jsonb DEFAULT '[]',closing_state text DEFAULT 'active',
      call_summary text,lead_id uuid,conversation_id uuid,disclosure_spoken boolean DEFAULT false,
      turn_count integer DEFAULT 0,detected_language text);
    CREATE TABLE ai_tasks(id uuid PRIMARY KEY,agency_id uuid,status text,kind text,input jsonb,output jsonb,error text,completed_at timestamptz);
    CREATE TABLE messages(id uuid PRIMARY KEY,agency_id uuid,conversation_id uuid,provider_message_id text,delivery_status text);
    CREATE TABLE leads(id uuid PRIMARY KEY,agency_id uuid);
    CREATE TABLE conversations(id uuid PRIMARY KEY,agency_id uuid,lead_id uuid);
    CREATE TABLE bookings(id uuid PRIMARY KEY,agency_id uuid,status text);
    CREATE TABLE quotations(id uuid PRIMARY KEY,agency_id uuid,status text);
    CREATE FUNCTION public.privilege_sentinel() RETURNS integer LANGUAGE sql AS 'SELECT 1';
    INSERT INTO agencies VALUES('${binding.agencyId}'),('${otherAgency}');
    INSERT INTO whatsapp_call_sessions(id,agency_id,call_id,gateway_session_id,meta_accepted_at,status)
      VALUES('${binding.sessionId}','${binding.agencyId}','${binding.callId}','${binding.gatewaySessionId}',now(),'answered'),
      ('${otherSession}','${otherAgency}','other-call','other-gateway',now(),'answered');`);
  const protectedState = async () => (await pg.query(`SELECT jsonb_build_object(
    'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl,'rls',c.relrowsecurity,
      'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY attnum) FROM pg_attribute a WHERE a.attrelid=c.oid)) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
        AND c.relname NOT LIKE 'calling_bridge_%' AND c.relname<>'calling_caller_turns'),
    'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY oid) FROM pg_default_acl d),
    'function',(SELECT jsonb_build_object('definition',pg_get_functiondef(oid),'acl',proacl) FROM pg_proc WHERE proname='privilege_sentinel')
    ) AS state`)).rows[0].state;
  const before = await protectedState();
  await pg.exec(repaired ? migration : originalMigration);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (![...entrypoints, ...helpers].includes(name)) throw new Error("fixture_rpc_name");
    return (await pg.query(`SELECT public.${name}(${Object.keys(args).map((k, i) => `${k}=>$${i + 1}`).join(",")}) AS result`, Object.values(args))).rows[0].result;
  };
  const asRole = async <T>(role: string, fn: () => Promise<T>): Promise<T> => {
    if (!["service_role", ...deniedRoles].includes(role)) throw new Error("fixture_role");
    await pg.exec(`SET ROLE ${role}`);
    try { return await fn(); } finally { await pg.exec("RESET ROLE"); }
  };
  return { pg, rpc, asRole, protectedState, before };
}
let f: Awaited<ReturnType<typeof database>>;
let lease: { generation: string; revision: number };
const ownerArgs = () => ({ ...base, p_sequence: 2, p_generation: lease.generation, p_revision: lease.revision });
beforeAll(async () => {
  f = await database();
  await f.asRole("service_role", async () => {
    await f.rpc("calling_bridge_begin", { ...base, p_sequence: 1, p_greeting: true, p_received_at: receivedAt, p_request_digest: digest });
    lease = await f.rpc("calling_bridge_begin", { ...base, p_sequence: 2, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest });
    await f.rpc("calling_bridge_persist_caller", { ...base, p_sequence: 2, p_generation: lease.generation,
      p_transcript: "Hantar quotation saya.", p_asr_completed_at: receivedAt, p_language: "ms", p_duration_ms: 1200 });
  });
});
afterAll(async () => { await f?.pg.close(); });

it("reproduces direct mutation on exact 4b46b594 migration with production default grants", async () => {
  expect(repair).toBeTruthy();
  expect(createHash("sha256").update(originalMigration).digest("hex")).toBe("19f36cf62993e23ba3ca5c933207ea2c6770c3ecb7d5dd67d109d235e78e35c0");
  const old = await database(false);
  try {
    for (const table of tables) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        expect((await old.pg.query("SELECT has_table_privilege('service_role',$1,$2) allowed", [table, privilege])).rows[0].allowed).toBe(true);
      }
      expect((await old.pg.query("SELECT has_table_privilege('sandbox_exec',$1,'INSERT') allowed", [table])).rows[0].allowed).toBe(true);
    }
    await old.asRole("service_role", async () => {
      await old.rpc("calling_bridge_begin", { ...base, p_sequence: 1, p_greeting: true, p_received_at: receivedAt, p_request_digest: digest });
      expect((await old.pg.query("UPDATE calling_bridge_sessions SET closing_state='terminal' RETURNING closing_state")).rows).toEqual([{ closing_state: "terminal" }]);
      await expect(old.pg.exec("DELETE FROM calling_bridge_actions")).resolves.toBeDefined();
    });
  } finally { await old.pg.close(); }
});

it.each(tables)("service_role reads %s but cannot directly insert, update, delete or truncate", async table => {
  await f.asRole("service_role", async () => {
    await expect(f.pg.exec(`SELECT * FROM public.${table}`)).resolves.toBeDefined();
    for (const sql of [`INSERT INTO public.${table} DEFAULT VALUES`, `UPDATE public.${table} SET agency_id=agency_id`, `DELETE FROM public.${table}`, `TRUNCATE public.${table}`]) {
      await expect(f.pg.exec(sql)).rejects.toMatchObject({ code: "42501" });
    }
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect((await f.pg.query("SELECT has_table_privilege(current_user,$1,$2) allowed", [table, privilege])).rows[0].allowed).toBe(false);
    }
    expect((await f.pg.query("SELECT has_table_privilege(current_user,$1,'SELECT WITH GRANT OPTION') allowed", [table])).rows[0].allowed).toBe(false);
  });
});

it.each(deniedRoles.flatMap(role => tables.map(table => ({ role, table }))))("$role has no direct access to $table", async ({ role, table }) => {
  await f.asRole(role, async () => {
    for (const sql of [`SELECT * FROM ${table}`, `INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET agency_id=agency_id`, `DELETE FROM ${table}`]) {
      await expect(f.pg.exec(sql)).rejects.toMatchObject({ code: "42501" });
    }
  });
});

it.each([...entrypoints, ...helpers])("%s retains its exact owner, EXECUTE boundary and safe search_path", async name => {
  const fn = (await f.pg.query("SELECT oid,proowner,prosecdef,proconfig FROM pg_proc WHERE proname=$1", [name])).rows[0];
  const owner = (await f.pg.query("SELECT oid FROM pg_roles WHERE rolname=current_user")).rows[0].oid;
  expect(fn.proowner).toBe(owner);
  expect(fn.prosecdef).toBe(name !== "calling_bridge_immutable");
  expect(fn.proconfig).toContain('search_path=""');
  for (const role of [...deniedRoles, "service_role"]) {
    expect((await f.pg.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, fn.oid])).rows[0].allowed)
      .toBe(role === "service_role" && entrypoints.includes(name));
    expect((await f.pg.query("SELECT has_function_privilege($1,$2,'EXECUTE WITH GRANT OPTION') allowed", [role, fn.oid])).rows[0].allowed).toBe(false);
  }
  expect((await f.pg.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [fn.oid])).rows[0].allowed).toBe(true);
});

it("governed state, append, playback and receipt writes work as service_role without direct table writes", async () => {
  await f.asRole("service_role", async () => {
    const snapshot = await f.rpc("calling_bridge_snapshot", base);
    expect(snapshot.callers).toHaveLength(1);
    expect(snapshot.callers[0].transcript).toBe("Hantar quotation saya.");
    expect(await f.rpc("calling_bridge_record", { ...ownerArgs(), p_kind: "telemetry", p_payload: { synthetic: true } })).toMatchObject({ ok: true });
    expect(await f.rpc("calling_bridge_output", { ...ownerArgs(), p_payload: { text: "Baik.", next_state: "active", language: "ms" } })).toMatchObject({ ok: true });
    expect(await f.rpc("calling_bridge_record", { ...ownerArgs(), p_kind: "handoff", p_payload: {} })).toMatchObject({ ok: true });
    expect(await f.rpc("calling_bridge_observe_media", { ...base, p_sequence: 3, p_metrics: { prev_sequence: 2, playback_complete_ms: 500 } })).toMatchObject({ ok: true });
    const action = { ...ownerArgs(), p_quotation: quotation };
    expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "claim" })).toMatchObject({ ok: true });
    expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "claim" })).toMatchObject({ ok: false, reason: "already_claimed" });
    expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "dispatch" })).toMatchObject({ ok: true });
    const receipt = { messageId: message, providerMessageId: "wamid.synthetic", quotationId: quotation };
    await expect(f.rpc("calling_bridge_action", { ...action, p_operation: "finish", p_result: { outcome: "verified_success", receipt } })).rejects.toMatchObject({ code: "42501" });
    // Existing governed sender evidence uses unchanged existing-table grants.
    await f.pg.query("INSERT INTO ai_tasks(id,agency_id,status,kind,input,output) VALUES($1,$2,'completed','deliver_existing_quotation_whatsapp',$3,$4)",
      [message, binding.agencyId, JSON.stringify({ call_id: binding.callId, quotation_id: quotation, conversation_id: conversation }), JSON.stringify(receipt)]);
    await f.pg.query("INSERT INTO messages(id,agency_id,conversation_id,provider_message_id,delivery_status) VALUES($1,$2,$3,'wamid.synthetic','sent')", [message, binding.agencyId, conversation]);
    expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "finish", p_result: { outcome: "verified_success", receipt } })).toMatchObject({ ok: true, outcome: "verified_success", receipt });
    expect(await f.rpc("calling_bridge_action", { ...action, p_operation: "reconcile" })).toMatchObject({ ok: true, outcome: "verified_success", receipt });
    const final = await f.rpc("calling_bridge_snapshot", base);
    expect(final.events.some((e: any) => e.kind === "playback_complete")).toBe(true);
    expect(final.actions).toHaveLength(1);
    expect(final.actions[0].state).toBe("verified_success");
  });
});

function argsFor(name: string, mismatched: Record<string, unknown>) {
  const common = { ...base, ...mismatched };
  switch (name) {
    case "calling_bridge_begin": return { ...common, p_sequence: 3, p_greeting: false, p_received_at: receivedAt, p_request_digest: digest };
    case "calling_bridge_persist_caller": return { ...common, p_sequence: 2, p_generation: lease.generation, p_transcript: "No mutation", p_asr_completed_at: receivedAt, p_language: "ms", p_duration_ms: 1000 };
    case "calling_bridge_snapshot": return common;
    case "calling_bridge_observe_media": return { ...common, p_sequence: 3, p_metrics: { prev_sequence: 2, playback_complete_ms: 500 } };
    case "calling_bridge_record": return { ...ownerArgs(), ...mismatched, p_kind: "telemetry", p_payload: {} };
    case "calling_bridge_action": return { ...ownerArgs(), ...mismatched, p_quotation: quotation, p_operation: "claim" };
    case "calling_bridge_output": return { ...ownerArgs(), ...mismatched, p_payload: { text: "No", next_state: "active" } };
    default: throw new Error("fixture_rpc");
  }
}
const mismatches = { p_agency: otherAgency, p_session: otherSession, p_call: "other-call", p_gateway: "other-gateway" };
it.each(entrypoints.flatMap(name => Object.entries(mismatches).map(([key, value]) => ({ name, key, value }))))("$name rejects crossed $key as service_role", async ({ name, key, value }) => {
  await f.asRole("service_role", async () => {
    await expect(f.rpc(name, argsFor(name, { [key]: value }))).rejects.toMatchObject({ code: "42501", message: "calling_binding_mismatch" });
  });
});

it.each(deniedRoles)("%s cannot invoke a SECURITY DEFINER entrypoint or the internal projection", async role => {
  await f.asRole(role, async () => {
    for (const name of entrypoints) await expect(f.rpc(name, argsFor(name, {}))).rejects.toMatchObject({ code: "42501" });
    await expect(f.rpc("calling_bridge_project", { p_agency: binding.agencyId, p_session: binding.sessionId })).rejects.toMatchObject({ code: "42501" });
  });
});
it("service_role cannot invoke the unbound internal projection", async () => {
  await f.asRole("service_role", async () => {
    await expect(f.rpc("calling_bridge_project", { p_agency: otherAgency, p_session: otherSession })).rejects.toMatchObject({ code: "42501" });
  });
});

it.each(["calling_bridge_turns", "calling_caller_turns", "calling_bridge_events"])("%s remains append-only even for its owner", async table => {
  expect((await f.pg.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBeGreaterThan(0);
  await expect(f.pg.exec(`UPDATE ${table} SET agency_id=agency_id`)).rejects.toMatchObject({ code: "55000" });
  await expect(f.pg.exec(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "55000" });
});

it("RLS remains enabled and independently denies an untrusted role even if a future SELECT grant is added", async () => {
  const rows = (await f.pg.query("SELECT relrowsecurity FROM pg_class WHERE relname=ANY($1)", [tables])).rows;
  expect(rows).toHaveLength(5); expect(rows.every((r: any) => r.relrowsecurity)).toBe(true);
  await f.pg.exec(`GRANT SELECT ON ${tables.join(",")} TO bridge_unprivileged`);
  try {
    await f.asRole("bridge_unprivileged", async () => {
      for (const table of tables) expect((await f.pg.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    });
  } finally { await f.pg.exec(`REVOKE SELECT ON ${tables.join(",")} FROM bridge_unprivileged`); }
});

it("old Worker table access, schema/grants/defaults and rollback-compatible projection stay intact", async () => {
  expect(await f.protectedState()).toEqual(f.before);
  await f.asRole("service_role", async () => {
    const session = (await f.pg.query("SELECT transcript,call_summary FROM whatsapp_call_sessions WHERE id=$1", [binding.sessionId])).rows[0];
    expect(session.transcript.some((t: any) => t.role === "customer" && t.text === "Hantar quotation saya.")).toBe(true);
    expect(session.call_summary).toContain("Delivered RAIŌ: Baik.");
    await expect(f.pg.query("UPDATE whatsapp_call_sessions SET status='answered' WHERE id=$1", [binding.sessionId])).resolves.toBeDefined();
    for (const table of ["messages", "bookings", "quotations"]) {
      expect((await f.pg.query("SELECT has_table_privilege(current_user,$1,'UPDATE') allowed", [table])).rows[0].allowed).toBe(true);
    }
  });
});

it("privilege repair is repeatable without data, function-definition or existing-schema drift", async () => {
  const snapshot = () => f.rpc("calling_bridge_snapshot", base);
  const before = await snapshot();
  const definitions = async () => (await f.pg.query("SELECT oid,pg_get_functiondef(oid) definition,proacl FROM pg_proc WHERE proname=ANY($1) ORDER BY oid", [[...entrypoints, ...helpers]])).rows;
  const funcs = await definitions();
  await f.pg.exec(repairTransaction);
  await f.pg.exec(repairTransaction);
  expect(await snapshot()).toEqual(before);
  expect(await definitions()).toEqual(funcs);
  expect(await f.protectedState()).toEqual(f.before);
  await f.asRole("service_role", async () => {
    await expect(f.pg.exec("UPDATE calling_bridge_sessions SET closing_state='terminal'")).rejects.toMatchObject({ code: "42501" });
    expect((await f.rpc("calling_bridge_snapshot", base)).live).toBe(true);
  });
});

it("keeps privilege correction inside original atomic migration; replay fails closed without partial changes", async () => {
  expect(migration.trim().endsWith("COMMIT;")).toBe(true);
  expect(originalMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
  expect(originalMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
  expect(repair).not.toMatch(/\b(?:DROP|TRUNCATE|INSERT|UPDATE|DELETE|ALTER\s+DEFAULT|CREATE\s+(?:TABLE|FUNCTION|POLICY))\b/);
  const before = await f.rpc("calling_bridge_snapshot", base);
  await expect(f.pg.exec(migration)).rejects.toMatchObject({ code: "42P07" });
  await f.pg.exec("ROLLBACK;");
  expect(await f.rpc("calling_bridge_snapshot", base)).toEqual(before);
  expect(await f.protectedState()).toEqual(f.before);
});

it("subsequent remote privilege-lock migration preserves the complete repaired permission boundary", async () => {
  const lock = readFileSync("supabase/migrations/20260910171000_calling_cognitive_bridge_privilege_lock.sql", "utf8");
  const acl = async () => (await f.pg.query(`
    SELECT 'table' kind,relname name,relacl::text acl FROM pg_class WHERE relname=ANY($1)
    UNION ALL SELECT 'function',proname,proacl::text FROM pg_proc WHERE proname=ANY($2)
    ORDER BY kind,name`, [tables, [...entrypoints, ...helpers]])).rows;
  const before = await acl();
  expect(before).toHaveLength(14);
  await f.pg.exec(lock);
  await f.pg.exec(lock);
  expect(await acl()).toEqual(before);
  expect(await f.protectedState()).toEqual(f.before);
  await f.asRole("service_role", async () => {
    expect((await f.rpc("calling_bridge_snapshot", base)).callers).toHaveLength(1);
    for (const table of tables) {
      await expect(f.pg.exec(`SELECT * FROM ${table}`)).resolves.toBeDefined();
      for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET agency_id=agency_id`, `DELETE FROM ${table}`]) {
        await expect(f.pg.exec(sql)).rejects.toMatchObject({ code: "42501" });
      }
    }
  });
});
