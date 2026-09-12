import { afterEach, expect, it, vi } from "vitest";
const send = vi.hoisted(()=>vi.fn());
vi.mock("@/lib/whatsapp-send.server",()=>({sendWhatsappTextDetailed:send}));
import { handleCognitiveVoiceTurn } from "../src/lib/calls/cognitive-bridge.server";
import { callingTurnResponse } from "../src/lib/calls/call-stream.server";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";
import type { CognitiveDecision, CognitivePacket, EngineMetadata } from "../src/lib/calls/cognitive-bridge.contract";
import { binding } from "./helpers/calling-bridge-db";
import { bridgeBusiness, businessIds } from "./helpers/calling-bridge-business";
import { decisionFixture } from "./helpers/calling-cognitive-fixtures";
const meta:EngineMetadata={configured_provider:"fixture",configured_model:"unchanged",returned_provider:null,returned_model:"unchanged",started_at:new Date().toISOString(),completed_at:new Date().toISOString(),latency_ms:1,input_tokens:100,output_tokens:20,fallback:false,cancellation:null};
const stores: Array<Awaited<ReturnType<typeof bridgeBusiness>> & {retained:Promise<unknown>[]}>=[];
afterEach(async()=>{for(const f of stores.splice(0)) {await Promise.all(f.retained); await f.pg.close();}vi.restoreAllMocks();});
async function runtime(){
 const f=await bridgeBusiness(); const retained:Promise<unknown>[]=[];stores.push(Object.assign(f,{retained}));
 let text="Awak sihat ke?";
 let decide=(packet:CognitivePacket):Promise<unknown>=>Promise.resolve(decisionFixture(packet));
 const model=vi.fn(async({packet}:{packet:CognitivePacket})=>({decision:await decide(packet),metadata:meta}));
 const present=vi.fn(async(text:string)=>({text,replyOggBase64:null,voiceId:"locked",languageBoost:"Malay"}));
 const args={db:f.db,binding,lifetime:{retain:(p:Promise<unknown>)=>{retained.push(p);}},callerPhone:"60123456789",language:"ms-MY",agencyName:"Synthetic",disclosureSpoken:false,
  voiceId:"locked",languageBoost:()=>"Malay",present,engine:{decide:model},asr:async()=>({text,language:"ms",durationSeconds:1,confidence:"unknown" as const,provider:"fixture",model:"fixture"})};
 const turn=(seq:number,extra:Partial<Parameters<typeof handleCognitiveVoiceTurn>[0]>={})=>handleCognitiveVoiceTurn({...args,receivedAt:Date.now(),signal:new AbortController().signal,
  payload:{call_id:binding.callId,sequence:seq,kind:seq===1?"greeting":"utterance",audio_ogg_base64:seq===1?null:btoa(`audio${seq}`),duration_ms:1000},...extra});
 const wire=async(seq:number,extra:Partial<Parameters<typeof handleCognitiveVoiceTurn>[0]>={})=>{
  const response=await callingTurnResponse({streaming:true,signal:extra.signal??new AbortController().signal,run:async(onAcknowledgement,signal)=>(await turn(seq,{...extra,onAcknowledgement,signal}))!});
  const events=(await response.text()).trim().split("\n").filter(Boolean).map(s=>JSON.parse(s));
  await Promise.all(retained);return events;
 };
 const snapshot=()=>f.rpc("calling_bridge_snapshot",bindingArgs(binding));
 return {...f,retained,turn,wire,model,present,snapshot,setText:(v:string)=>{text=v;},setDecision:(fn:typeof decide)=>{decide=fn;}};
}
it("preserves system-first opening, disclosure and cached human presentation without a model invocation",async()=>{
 const f=await runtime();const events=await f.wire(1);expect(events.at(-1)).toMatchObject({type:"final",end_call:false,voice_id:"locked"});
 expect(events.at(-1).speech_text).toMatch(/RAIŌ|RAI.O|UMRAIO/i);expect(events.at(-1).backchannel_texts).toHaveLength(3);expect(f.model).not.toHaveBeenCalled();
 const s=await f.snapshot();expect(s.events.map((e:{kind:string})=>e.kind)).toEqual(expect.arrayContaining(["proposal","handoff","telemetry"]));
 expect(s.events.some((e:{kind:string})=>e.kind==="playback_complete")).toBe(false);
});
it("uses one semantic invocation, durable caller evidence and only confirmed assistant playback",async()=>{
 const f=await runtime();await f.wire(1);
 await f.wire(2,{payload:{call_id:binding.callId,sequence:2,kind:"utterance",duration_ms:1000,audio_ogg_base64:btoa("two"),media_metrics:{prev_sequence:1,playback_complete_ms:2100}}});
 expect(f.model).toHaveBeenCalledTimes(1);const packet=f.model.mock.calls[0]![0].packet;
 expect(packet.current_call.current_caller.transcript).toBe("Awak sihat ke?");expect(packet.current_call.delivered_assistant_refs).toHaveLength(1);
 expect(packet.renagi).toBeNull();expect((await f.snapshot()).callers).toHaveLength(1);
});
it.each(["Ja","Skjab, skjab","Saya nak e-mel belum boleh hantar."])("clarifies uncertain input %s without entity writes",async text=>{
 const f=await runtime();await f.wire(1);f.setText(text);f.setDecision(async p=>decisionFixture(p,{interaction_mode:"CLARIFY",requires_clarification:true,spoken_response:"Maksudnya macam mana ya?"}));
 const result=await f.wire(2);expect(result.at(-1).speech_text).toBe("Apakah perkara utama yang ingin ditanya?");
 const proposal=(await f.snapshot()).events.find((e:{kind:string;sequence:number})=>e.kind==="proposal"&&e.sequence===2);
 expect(proposal.payload.response_classification).toBe("GENUINE_CLARIFICATION_REQUIRED");
 expect(proposal.payload.clarification.fact).toBe("caller_request");
 expect((await f.pg.query("SELECT full_name FROM leads")).rows[0].full_name).toBe("Dato’ Synthetic");
});
it.each(["Saya akan hantar quotation.","Quotation akan dihantar.","Pihak agensi akan uruskan.","Quotation sudah dibaca."])("blocks unsupported execution speech: %s",async speech=>{
 const f=await runtime();await f.wire(1);f.setDecision(async p=>decisionFixture(p,{spoken_response:speech}));
 const result=await f.wire(2);expect(result.at(-1).speech_text).not.toBe(speech);
 expect(result.at(-1).speech_text).toBe("Saya sedia membantu, terima kasih kerana bertanya.");
 expect(result.at(-1).speech_text).not.toContain("?");
});
it("delivers a real governed receipt before speaking completion",async()=>{
 const f=await runtime();await f.wire(1);f.setText("Hantar quotation sekarang dekat WhatsApp, boleh?");
 f.setDecision(async p=>decisionFixture(p,{interaction_mode:"EXECUTE",action_required:true,intent:"quotation_delivery",allowed_tool:"deliver_existing_quotation_whatsapp",
  requested_action:{name:"deliver_existing_quotation_whatsapp",quotation_id:businessIds.quotation,evidence_quote:p.current_call.current_caller.transcript},spoken_response:"Baik."}));
 send.mockResolvedValue({ok:true,providerMessageId:"wamid.runtime",outcome:"verified_success",dispatched:true});
 const events=await f.wire(2);expect(events.at(-1).speech_text).toContain("sudah dihantar");
 expect((await f.pg.query("SELECT state FROM calling_bridge_actions")).rows[0].state).toBe("verified_success");
 expect((await f.pg.query("SELECT provider_message_id FROM messages")).rows[0].provider_message_id).toBe("wamid.runtime");
});
it.each(Array.from({length:20},(_,i)=>i))("commits one semantic farewell and retains gateway termination ordering %i",async()=>{
 const f=await runtime();await f.wire(1);f.setText("Oklah itulah, nanti saya call awak balik.");
 f.setDecision(async p=>decisionFixture(p,{interaction_mode:"CLOSE",completion_intent:"confirmed",next_state:"farewell_committed",spoken_response:"Baik, terima kasih. Assalamualaikum."}));
 const result=await f.wire(2);expect(result.at(-1)).toMatchObject({end_call:true,reason:"conversation_complete"});
 let s=await f.snapshot();expect(s.closing_state).toBe("farewell_committed");expect(s.farewell_id).toBeTruthy();
 expect(await f.turn(2)).toMatchObject({ok:false});expect(s.events.filter((e:{kind:string;sequence:number})=>e.kind==="proposal"&&e.sequence===2)).toHaveLength(1);
 expect(s.events.filter((e:{kind:string;sequence:number})=>e.kind==="playback_complete"&&e.sequence===2)).toHaveLength(0);
 await f.pg.exec("UPDATE whatsapp_call_sessions SET status='terminated'");s=await f.snapshot();expect(s.closing_state).toBe("terminal");expect(s.live).toBe(false);
});
it("rejects stale endCall after fresh caller resumption, without erasing completed speech",async()=>{
 const f=await runtime();await f.wire(1);f.setText("Itu sahaja.");
 f.setDecision(async p=>decisionFixture(p,{interaction_mode:"CLOSE",completion_intent:"confirmed",next_state:"farewell_committed",spoken_response:"Terima kasih, selamat tinggal."}));
 const close=await f.turn(2);expect(close).toMatchObject({ok:true,endCall:true});
 f.setText("Sekejap, saya ada soalan lagi.");f.setDecision(async p=>decisionFixture(p,{spoken_response:"Ya, silakan."}));
 await f.wire(3);if(close?.ok) expect(await close.speechEligibility?.()).toBe(false);
 const s=await f.snapshot();expect(s.closing_state).toBe("active");expect(s.callers).toHaveLength(2);
});
it("keeps caller speech exactly once when response is cancelled during the model",async()=>{
 const f=await runtime();await f.wire(1);const abort=new AbortController();
 f.setDecision(async p=>{abort.abort();return decisionFixture(p);});
 expect(await f.turn(2,{signal:abort.signal})).toMatchObject({ok:false});
 const s=await f.snapshot();expect(s.callers).toHaveLength(1);expect(s.events.some((e:{kind:string;sequence:number})=>e.kind==="proposal"&&e.sequence===2)).toBe(false);
 const projection=(await f.pg.query("SELECT transcript FROM whatsapp_call_sessions")).rows[0].transcript;
 expect(projection.filter((t:{role:string})=>t.role==="customer")).toHaveLength(1);
});
it("emits a neutral acknowledgement only while a live substantive decision is pending",async()=>{
 const f=await runtime();await f.wire(1);
 let resolve!:()=>void;const ready=new Promise<void>(r=>{resolve=r;});
 f.setDecision(async p=>{await ready;return decisionFixture(p);});
 const ack=vi.fn(()=>resolve());const result=await f.turn(2,{onAcknowledgement:ack});
 expect(result).toMatchObject({ok:true});expect(ack).toHaveBeenCalledTimes(1);expect(ack.mock.calls[0]![0].text).toMatch(/^Baik/);
 expect(ack.mock.calls[0]![0].text).not.toMatch(/periksa|cek|faham/i);
});
it("never emits a filler when a substantive answer is already ready",async()=>{
 const f=await runtime();await f.wire(1);const ack=vi.fn();await f.turn(2,{onAcknowledgement:ack});expect(ack).not.toHaveBeenCalled();
});
it("allows only one closing clarification per episode and never turns ambiguous OK into an action",async()=>{
 const f=await runtime();await f.wire(1);f.setText("OK.");
 f.setDecision(async p=>decisionFixture(p,{interaction_mode:"CLARIFY",requires_clarification:true,completion_intent:"possible",next_state:"possible_completion",spoken_response:"Itu sahaja untuk sekarang?"}));
 expect((await f.wire(2)).at(-1).end_call).toBe(false);expect((await f.snapshot()).closing_clarifications).toBe(1);
 const repeated=await f.wire(3);expect(repeated.at(-1).speech_text).not.toContain("?");expect(repeated.at(-1).end_call).toBe(false);
 expect((await f.pg.query("SELECT * FROM calling_bridge_actions")).rows).toHaveLength(0);
});
it("preserves current objective and corrections with caller provenance beyond the rolling history window",async()=>{
 const f=await runtime();await f.wire(1);const text="Saya maksudkan quotation Q-2026-0007.";f.setText(text);
 f.setDecision(async p=>decisionFixture(p,{spoken_response:"Baik.",memory_update:{objective:{text,evidence_quote:text,source_refs:[`caller:${p.identity.caller_turn_id}`]},corrections:[],open_questions:[]}}));
 await f.wire(2);f.setText("Status bayaran macam mana?");f.setDecision(async p=>decisionFixture(p,{spoken_response:"Saya dengar soalan tentang bayaran."}));await f.wire(20);
 const packet=f.model.mock.calls.at(-1)![0].packet;expect(packet.current_call.objective).toBe(text);expect(packet.current_call.objective_ref).toBeTruthy();
 const fact=packet.evidence.find(e=>e.id===packet.current_call.objective_ref)!;expect(fact.authority).toBe("caller_statement");expect(fact.recorded_at).toBeTruthy();
 expect(packet.business.selected_quotation).toBe(businessIds.quotation);expect(packet.current_call.missing_sequences).not.toHaveLength(0);
});
it("measures local bridge overhead over 30 live turns while keeping one cognitive invocation per turn",async()=>{
 const f=await runtime();await f.wire(1);const samples:number[]=[];
 for(let sequence=2;sequence<=31;sequence++){
  f.setText(`Ini soalan sintetik ${sequence}.`);await f.wire(sequence);
  const snapshot=await f.snapshot();const t=snapshot.events.find((e:{kind:string;sequence:number})=>e.kind==="telemetry"&&e.sequence===sequence).payload.timings;
  samples.push(t.response_complete-t.received);
 }
 expect(f.model).toHaveBeenCalledTimes(30);expect(samples.every(Number.isFinite)).toBe(true);
 const sorted=[...samples].sort((a,b)=>a-b);
 const {mkdir,writeFile}=await import("node:fs/promises");await mkdir("logs",{recursive:true});
 await writeFile("logs/calling-bridge-latency.json",JSON.stringify({sample_count:30,scope:"local PGlite; synthetic ASR and engine; no TTS/network; not Founder latency",p50_ms:sorted[14],p95_ms:sorted[28],max_ms:sorted.at(-1),model_invocations:30}));
});

it("speaks a committed farewell even when caller audio supersedes the turn without new business",async()=>{
 const f=await runtime();await f.wire(1);f.setText("Itu sahaja, terima kasih.");
 f.setDecision(async p=>decisionFixture(p,{interaction_mode:"CLOSE",completion_intent:"confirmed",next_state:"farewell_committed",spoken_response:"Baik, terima kasih. Assalamualaikum."}));
 const close=await f.turn(2);expect(close).toMatchObject({ok:true,endCall:true,reason:"conversation_complete"});
 f.setText("Ok.");await f.wire(3);
 if(close?.ok) expect(await close.speechEligibility?.()).toBe(true);
});
it("re-commits the farewell and ends the call when the caller speaks again with no new business",async()=>{
 const f=await runtime();await f.wire(1);f.setText("Itu sahaja, terima kasih.");
 f.setDecision(async p=>decisionFixture(p,{interaction_mode:"CLOSE",completion_intent:"confirmed",next_state:"farewell_committed",spoken_response:"Baik, terima kasih. Assalamualaikum."}));
 await f.wire(2);expect(f.model).toHaveBeenCalledTimes(1);
 f.setText("Ok.");const events=await f.wire(3);
 expect(events.at(-1)).toMatchObject({type:"final",end_call:true,reason:"conversation_complete"});
 expect(events.at(-1).speech_text).not.toContain("?");
 expect(f.model).toHaveBeenCalledTimes(1);
 expect((await f.snapshot()).closing_state).toBe("farewell_committed");
});
it("keeps answering when the caller raises new business after a farewell",async()=>{
 const f=await runtime();await f.wire(1);f.setText("Itu sahaja, terima kasih.");
 f.setDecision(async p=>decisionFixture(p,{interaction_mode:"CLOSE",completion_intent:"confirmed",next_state:"farewell_committed",spoken_response:"Baik, terima kasih. Assalamualaikum."}));
 await f.wire(2);
 f.setText("Sekejap, harga pakej Umrah berapa ya?");f.setDecision(async p=>decisionFixture(p,{spoken_response:"Ya, saya jelaskan."}));
 const events=await f.wire(3);expect(events.at(-1)).toMatchObject({end_call:false});expect(f.model).toHaveBeenCalledTimes(2);
});
it("ends the call on an explicit hangup instruction without a model turn",async()=>{
 const f=await runtime();await f.wire(1);f.setText("Awak putuskanlah panggilan ni.");
 const events=await f.wire(2);
 expect(events.at(-1)).toMatchObject({type:"final",end_call:true,reason:"conversation_complete"});
 expect(events.at(-1).speech_text).toMatch(/terima kasih|assalamualaikum/i);
 expect(f.model).not.toHaveBeenCalled();
});
