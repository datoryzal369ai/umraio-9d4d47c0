import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { binding, binding as owner, digest, receivedAt } from "./helpers/calling-bridge-db";
import { bridgeBusiness, businessIds } from "./helpers/calling-bridge-business";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";
import { boundedCallingDb } from "../src/lib/calls/calling-db-lifetime.server";
let f:Awaited<ReturnType<typeof bridgeBusiness>>;
let generation:string;
beforeAll(async()=>{ f=await bridgeBusiness(); const lease=await f.rpc("calling_bridge_begin",{...bindingArgs(binding),p_sequence:1,p_greeting:true,p_received_at:receivedAt,p_request_digest:digest});generation=lease.generation;});
afterAll(async()=>{await f.pg.close();});
it("all Calling-only storage is RLS-protected and clients cannot invoke privileged mutations",async()=>{
 const tables=["calling_bridge_sessions","calling_bridge_turns","calling_caller_turns","calling_bridge_events","calling_bridge_actions"];
 const states=await f.pg.query("SELECT relname,relrowsecurity FROM pg_class WHERE relname=ANY($1)",[tables]);
 expect(states.rows).toHaveLength(5);expect(states.rows.every((r:{relrowsecurity:boolean})=>r.relrowsecurity)).toBe(true);
 for(const role of ["anon","authenticated"]){
  await f.pg.exec(`SET ROLE ${role}`);
  for(const table of tables) await expect(f.pg.exec(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
  await expect(f.rpc("calling_bridge_snapshot",bindingArgs(binding))).rejects.toThrow(/permission denied/);
  await expect(f.rpc("calling_bridge_action",{...bindingArgs(binding),p_sequence:1,p_generation:generation,p_revision:1,p_quotation:businessIds.quotation,p_operation:"claim"})).rejects.toThrow(/permission denied/);
  await f.pg.exec("RESET ROLE");
 }
 await f.pg.exec("SET ROLE service_role");
 await expect(f.pg.exec("UPDATE calling_bridge_sessions SET closing_state='terminal'")).rejects.toThrow(/permission denied/);
 await f.pg.exec("RESET ROLE");
});
it.each(["agencyId","sessionId","callId","gatewaySessionId"] as const)("rejects mismatched %s on evidence, output and actions",async key=>{
 const foreign={...owner,[key]:key.endsWith("Id")&&!key.startsWith("call")&&!key.startsWith("gateway")?businessIds.lead:"wrong-call-binding"};
 const base=bindingArgs(foreign);
 await expect(f.rpc("calling_bridge_snapshot",base)).rejects.toThrow("calling_binding_mismatch");
 await expect(f.rpc("calling_bridge_output",{...base,p_sequence:1,p_generation:generation,p_revision:1,p_payload:{text:"No",next_state:"active"}})).rejects.toThrow("calling_binding_mismatch");
 await expect(f.rpc("calling_bridge_action",{...base,p_sequence:1,p_generation:generation,p_revision:1,p_quotation:businessIds.quotation,p_operation:"claim"})).rejects.toThrow("calling_binding_mismatch");
});
it("will not migrate an already-running legacy call even through a repeated greeting",async()=>{
 const other="66666666-6666-4666-8666-666666666666";
 await f.pg.query("INSERT INTO whatsapp_call_sessions(id,agency_id,call_id,gateway_session_id,meta_accepted_at,status,turn_count,disclosure_spoken) VALUES($1,$2,'legacy','legacy-gateway',now(),'answered',2,true)",[other,binding.agencyId]);
 expect(await f.rpc("calling_bridge_begin",{p_agency:binding.agencyId,p_session:other,p_call:"legacy",p_gateway:"legacy-gateway",p_sequence:1,p_greeting:true,p_received_at:receivedAt,p_request_digest:digest})).toMatchObject({state:"legacy"});
});
it("reconciles an already-persisted governed receipt without any new dispatch",async()=>{
 const base={...bindingArgs(binding),p_sequence:1,p_generation:generation,p_revision:1,p_quotation:businessIds.quotation};
 await f.rpc("calling_bridge_action",{...base,p_operation:"claim"});
 await f.rpc("calling_bridge_action",{...base,p_operation:"dispatch"});
 const receipt={messageId:businessIds.lead,providerMessageId:"wamid.reconcile",quotationId:businessIds.quotation};
 await f.pg.query("INSERT INTO ai_tasks(id,agency_id,kind,status,input,output) VALUES($1,$2,'deliver_existing_quotation_whatsapp','running',$3,$4)",
  [receipt.messageId,binding.agencyId,JSON.stringify({call_id:binding.callId,quotation_id:businessIds.quotation,conversation_id:businessIds.conversation}),JSON.stringify(receipt)]);
 await f.pg.query("INSERT INTO messages(id,agency_id,conversation_id,provider_message_id,delivery_status) VALUES($1,$2,$3,$4,'delivered')",[receipt.messageId,binding.agencyId,businessIds.conversation,receipt.providerMessageId]);
 await f.pg.exec("UPDATE whatsapp_call_sessions SET status='terminated' WHERE call_id='calling-test'");
 expect(await f.rpc("calling_bridge_action",{...base,p_operation:"reconcile"})).toMatchObject({ok:true,outcome:"verified_success",receipt});
 expect((await f.pg.query("SELECT status FROM ai_tasks")).rows[0].status).toBe("completed");
 expect((await f.pg.query("SELECT count(*)::int n FROM messages")).rows[0].n).toBe(1);
 expect((await f.rpc("calling_bridge_snapshot",bindingArgs(binding))).live).toBe(false);
});
it("cancels an actual PostgREST receipt/body read, including lazy maybeSingle queries",async()=>{
 let ready!:()=>void,closed!:()=>void;
 const headers=new Promise<void>(r=>{ready=r;}),socketClosed=new Promise<void>(r=>{closed=r;});
 const server=createServer((_req,res)=>{res.writeHead(200,{"Content-Type":"application/json"});res.write('{"id":');res.on("close",closed);ready();});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 try{
  const port=(server.address() as {port:number}).port;
  const client=createClient(`http://127.0.0.1:${port}`,"synthetic",{auth:{persistSession:false,autoRefreshToken:false}});
  const controller=new AbortController();const db=boundedCallingDb(client,controller.signal);
  const pending=Promise.resolve(db.from("calling_bridge_actions").select("id").maybeSingle());
  await headers;controller.abort();const result=await pending;expect(result.error).toBeTruthy();await socketClosed;
 } finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
