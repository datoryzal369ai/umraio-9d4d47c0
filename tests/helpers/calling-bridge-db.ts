/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export const bridgeTestRequire = createRequire(resolve(process.env.CALLING_BRIDGE_TEST_TOOLS ?? "tests/calling-bridge-tools", "package.json"));
export const binding = { agencyId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222",
  callId: "calling-test", gatewaySessionId: "gateway-test" };
export const digest = "a".repeat(64);
export const receivedAt = "2026-09-10T17:00:00Z";

export async function bridgeDatabase(options: { liveAcceptance?: boolean } = {}) {
  const { PGlite } = bridgeTestRequire("@electric-sql/pglite");
  const pg = new PGlite();
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.agencies(id uuid PRIMARY KEY);
    CREATE TABLE public.ai_tasks(id uuid PRIMARY KEY,agency_id uuid,status text,kind text,input jsonb,output jsonb);
    CREATE TABLE public.messages(id uuid PRIMARY KEY,agency_id uuid,provider_message_id text,delivery_status text);
    CREATE TABLE public.whatsapp_call_sessions(id uuid PRIMARY KEY,agency_id uuid,call_id text,gateway_session_id text,
      meta_accepted_at timestamptz,status text,transcript jsonb DEFAULT '[]',closing_state text DEFAULT 'active',
      call_summary text,lead_id uuid,conversation_id uuid,disclosure_spoken boolean DEFAULT false,turn_count integer DEFAULT 0,detected_language text,voice_latency jsonb DEFAULT '[]');
    INSERT INTO public.agencies VALUES ('${binding.agencyId}');
    INSERT INTO public.whatsapp_call_sessions(id,agency_id,call_id,gateway_session_id,meta_accepted_at,status)
      VALUES ('${binding.sessionId}','${binding.agencyId}','${binding.callId}','${binding.gatewaySessionId}',now(),'answered');`);
  await pg.exec(readFileSync(resolve("supabase/migrations/20260910170000_calling_cognitive_bridge_v1.sql"), "utf8"));
  await pg.exec(readFileSync(resolve("supabase/migrations/20260910171000_calling_cognitive_bridge_privilege_lock.sql"), "utf8"));
  if (options.liveAcceptance !== false) {
    await pg.exec(readFileSync(resolve("supabase/migrations/20260910172000_calling_cognitive_bridge_live_acceptance.sql"), "utf8"));
  }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (!/^calling_bridge_[a-z_]+$/.test(name)) throw new Error("test_rpc_name");
    const entries = Object.entries(args);
    const result = await pg.query(`SELECT public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(",")}) AS result`, entries.map(([,value]) => value));
    return result.rows[0].result;
  };
  const db = { rpc: (name: string, args: Record<string, unknown>) => {
    let signal: AbortSignal | undefined;
    const execute = async () => {
      signal?.throwIfAborted();
      try { return { data: await rpc(name, args), error: null }; }
      catch (error: any) { return { data: null, error: { code: error.code, message: error.message } }; }
    };
    const query = { abortSignal: (owner: AbortSignal) => { signal = owner; return query; },
      then: (resolve: any, reject: any) => execute().then(resolve, reject) };
    return query;
  }, from: () => { throw new Error("test_use_scoped_sql"); } };
  return { pg, rpc, db };
}
