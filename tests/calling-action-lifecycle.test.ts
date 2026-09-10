import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/whatsapp-send.server", () => ({ sendWhatsappTextDetailed: mocks.send }));
import { executeCallingDecision } from "../src/lib/calls/calling-action-lifecycle.server";
import { bindingArgs, retainCallerTurn } from "../src/lib/calls/caller-turn-ledger.server";
import { buildCognitivePacket, loadCallingRecords, type BridgeSnapshot } from "../src/lib/calls/cognitive-state.server";
import { binding, digest, receivedAt } from "./helpers/calling-bridge-db";
import { bridgeBusiness, businessIds } from "./helpers/calling-bridge-business";
import { decisionFixture } from "./helpers/calling-cognitive-fixtures";
const text = "Hantar quotation sekarang dekat WhatsApp, boleh?";
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const f = await bridgeBusiness(); const retained: Promise<unknown>[]=[]; const lifetime = { retain: (p: Promise<unknown>) => { retained.push(p); } };
  const base = bindingArgs(binding);
  await f.rpc("calling_bridge_begin", { ...base, p_sequence: 1, p_greeting: true, p_received_at: receivedAt, p_request_digest: digest });
  const lease = await retainCallerTurn({ db:f.db,binding,sequence:2,greeting:false,receivedAt,lifetime,durationMs:1200,requestDigest:digest,
    asr:async()=>({text,language:"ms",confidence:"unknown",durationSeconds:1.2,provider:"fixture",model:"fixture"}) });
  const records = await loadCallingRecords(f.db,{binding,callerPhone:"60123456789",signal:new AbortController().signal});
  const packet = buildCognitivePacket({binding,sequence:2,caller:lease.turn!,snapshot:await f.rpc("calling_bridge_snapshot",base) as BridgeSnapshot,records,language:"ms"});
  const decision = decisionFixture(packet,{interaction_mode:"EXECUTE",intent:"quotation_delivery",action_required:true,allowed_tool:"deliver_existing_quotation_whatsapp",
    requested_action:{name:"deliver_existing_quotation_whatsapp",quotation_id:businessIds.quotation,evidence_quote:text},spoken_response:"Baik."});
  const controller = new AbortController();
  const run=()=>executeCallingDecision({db:f.db,binding,packet,decision,lifetime,responseSignal:controller.signal,timings:{}});
  return {...f,retained,packet,decision,controller,run,base};
}
it("invokes existing governed sender and independently persists provider receipt after interruption",async()=>{
  const f=await setup();
  try {
    mocks.send.mockImplementation(async()=>{f.controller.abort();return {ok:true,providerMessageId:"wamid.synthetic",outcome:"verified_success",dispatched:true};});
    expect(await f.run()).toMatchObject({ok:true,receipt:{providerMessageId:"wamid.synthetic"}});
    expect((await f.pg.query("SELECT state FROM calling_bridge_actions")).rows).toEqual([{state:"verified_success"}]);
    expect((await f.pg.query("SELECT kind FROM calling_bridge_events WHERE kind='action_verified'")).rows).toHaveLength(1);
    await Promise.all(f.retained);
  } finally {await f.pg.close();}
});
it.each(Array.from({length:20},(_,i)=>i))("retains unknown ownership without duplicate send under concurrent requests %i",async()=>{
  const f=await setup();
  try {
    mocks.send.mockReset().mockResolvedValue({ok:false,providerMessageId:null,outcome:"outcome_unknown",cause:"timeout",dispatched:true});
    const results=await Promise.all([f.run(),f.run(),f.run()]);
    expect(results.every(r=>!r.ok)).toBe(true); expect(mocks.send).toHaveBeenCalledTimes(1);
    expect((await f.pg.query("SELECT state FROM calling_bridge_actions")).rows).toEqual([{state:"outcome_unknown"}]);
    expect((await f.pg.query("SELECT * FROM messages")).rows).toHaveLength(0);
    await Promise.all(f.retained);
  } finally {await f.pg.close();}
});
it("rejects stale generation immediately before irreversible dispatch",async()=>{
  const f=await setup();
  try {
    await f.rpc("calling_bridge_begin",{...f.base,p_sequence:3,p_greeting:false,p_received_at:receivedAt,p_request_digest:digest});
    mocks.send.mockReset(); expect(await f.run()).toMatchObject({ok:false,reason:"stale_turn"}); expect(mocks.send).not.toHaveBeenCalled();
  } finally {await f.pg.close();}
});
it("never accepts a fabricated success without the governed persisted message receipt",async()=>{
  const f=await setup();
  const args={...f.base,p_sequence:2,p_generation:f.packet.identity.generation,p_revision:f.packet.identity.input_revision,p_quotation:businessIds.quotation};
  try {
    await f.rpc("calling_bridge_action",{...args,p_operation:"claim"});
    await expect(f.rpc("calling_bridge_action",{...args,p_operation:"finish",p_result:{outcome:"verified_success",receipt:{messageId:businessIds.lead,providerMessageId:"invented"}}})).rejects.toThrow("calling_verified_receipt_required");
  } finally {await f.pg.close();}
});
it("preserves a complete provider rejection as verified failure, not cancellation or unknown",async()=>{
 const f=await setup();try{
  mocks.send.mockReset().mockResolvedValue({ok:false,providerMessageId:null,outcome:"verified_failure",cause:"provider_rejection",dispatched:true,httpStatus:400});
  expect(await f.run()).toMatchObject({ok:false,outcome:"verified_failure"});
  expect((await f.pg.query("SELECT state FROM calling_bridge_actions")).rows[0].state).toBe("verified_failure");
 }finally{await Promise.all(f.retained);await f.pg.close();}
});
it("does not invent unknown delivery when cancellation after the dispatch fence prevents HTTP from starting",async()=>{
 const f=await setup();const original=f.db.rpc.bind(f.db);try{
  vi.spyOn(f.db,"rpc").mockImplementation((name,args)=>{
   const q=original(name,args);if(name!=="calling_bridge_action"||args.p_operation!=="dispatch")return q;
   const proxy={abortSignal:(signal:AbortSignal)=>{q.abortSignal(signal);return proxy;},then:(resolve:any,reject:any)=>q.then((value:any)=>{f.controller.abort();return resolve(value);},reject)};return proxy;
  });
  mocks.send.mockReset();expect(await f.run()).toMatchObject({ok:false,outcome:"cancelled"});expect(mocks.send).not.toHaveBeenCalled();
  expect((await f.pg.query("SELECT state FROM calling_bridge_actions")).rows[0].state).toBe("cancelled");
 }finally{await Promise.all(f.retained);await f.pg.close();}
});
