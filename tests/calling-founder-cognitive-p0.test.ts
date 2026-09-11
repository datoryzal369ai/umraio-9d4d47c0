import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/whatsapp-send.server", () => ({ sendWhatsappTextDetailed: send }));
import { handleCognitiveVoiceTurn } from "../src/lib/calls/cognitive-bridge.server";
import { callingTurnResponse } from "../src/lib/calls/call-stream.server";
import { reconstructCallingMemory } from "../src/lib/calls/cognitive-engine.server";
import { callingGenerationSchema, bindCallingGeneratedDecision, type CognitiveDecision, type CognitivePacket, type EngineMetadata } from "../src/lib/calls/cognitive-bridge.contract";
import { validateCallingDecision, callingValidationFields } from "../src/lib/calls/call-decision-policy.core";
import { callingContractRecovery } from "../src/lib/calls/call-speech-claims.core";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";
import { decisionFixture, packetFixture, recordsFixture, callerFixture } from "./helpers/calling-cognitive-fixtures";
import { bridgeBusiness, businessIds } from "./helpers/calling-bridge-business";
import { binding } from "./helpers/calling-bridge-db";

const transcripts = [
  "Assalamualaikum. Salam Jumaat. Saya nak tanya pasal pakej umrah ni. Nak tengok status saya ni?",
  "Awak kena rekod tembahan saya.",
  "Awak kenapa tak saya ni Datuk Rizal tak tanya saya, Datuk Rizal? Siapa-siapa yang call? Saya nak tahu status saya punya tempahan tempoh hari tu.",
  "Tadi lain saya cakap, awak ni tanya saya banyak kali pula.",
  "Kapaang faham?",
  "Macam itulah saya cakap tadi, tak apalah saya orang tak faham.",
  "Okeylah, takpe. Terima kasih, bye.",
];
const current = { revision: 2, generation: "generation-2", live: true, cancelled: false };
const memory = (p: CognitivePacket, quote = p.current_call.current_caller.transcript) => ({text:quote,evidence_quote:quote,source_refs:[`caller:${p.identity.caller_turn_id}`]});
const malformedMemory = (p: CognitivePacket) => decisionFixture(p, {spoken_response:"Saya dengar soalan tadi.",
  memory_update:{objective:{...memory(p),text:"A generated summary instead of the caller's words"},corrections:[],open_questions:[]}});

describe("evidence-bound construction without relaxing the original veto", () => {
  it("rejects paraphrased memory, then binds only the exact authoritative current quote", () => {
    const p=packetFixture(transcripts[0]); const raw=malformedMemory(p);
    expect(validateCallingDecision(raw,p,current)).toEqual({ok:false,reason:"unsupported_memory"});
    expect(callingValidationFields(raw,p,"unsupported_memory")).toContain("memory_update.objective.text_quote_equality");
    const repaired=reconstructCallingMemory(raw,p,"unsupported_memory")!;
    expect(repaired.memory_update.objective).toEqual(memory(p));
    expect(validateCallingDecision(repaired,p,current).ok).toBe(true);
    expect(raw.memory_update.objective!.text).toBe("A generated summary instead of the caller's words");
  });
  it("rebinds an exact caller quote's malformed memory reference, without accepting the invented original", () => {
    const p=packetFixture(transcripts[0]); const d=decisionFixture(p,{memory_update:{objective:{...memory(p),source_refs:["caller:made-up"]},corrections:[],open_questions:[]}});
    expect(validateCallingDecision(d,p,current)).toEqual({ok:false,reason:"invented_source"});
    expect(callingValidationFields(d,p,"invented_source")).toEqual(["memory_update.objective.source_refs"]);
    const repaired=reconstructCallingMemory(d,p,"invented_source")!;
    expect(repaired.memory_update.objective!.source_refs).toEqual(["caller:caller-2"]);
    expect(validateCallingDecision(repaired,p,current).ok).toBe(true);
  });
  it.each(["authoritative", "uncertainty", "claim"])("does not guess or erase invented %s references", kind => {
    const p=packetFixture(); const d=decisionFixture(p, kind==="authoritative"?{authoritative_facts_used:["made-up"]}
      :kind==="uncertainty"?{uncertainties:[{detail:"Unavailable",source_refs:["made-up"]}]}
      :{claim_requests:[{kind:"identity",source_ref:"made-up",spoken_span:"Saya"}]} );
    expect(validateCallingDecision(d,p,current)).toEqual({ok:false,reason:"invented_source"});
    expect(reconstructCallingMemory(d,p,"invented_source")).toBeNull();
  });
  it.each(["Your booking is paid", "Traveller's name is Ja"])("does not reconstruct an absent quote: %s", quote => {
    const p=packetFixture("Ja"); const d=decisionFixture(p,{memory_update:{objective:memory(p,quote),corrections:[],open_questions:[]}});
    expect(validateCallingDecision(d,p,current)).toEqual({ok:false,reason:"unsupported_memory"});
    expect(reconstructCallingMemory(d,p,"unsupported_memory")).toBeNull();
  });
  it("keeps exact prior-turn information in context instead of falsely writing it as current speech", () => {
    const prior={...callerFixture(transcripts[0]),id:"caller-1",sequence:1};
    const p=packetFixture(transcripts[3],recordsFixture(),{callers:[prior,callerFixture(transcripts[3])],
      memory:{objective:{text:prior.transcript,source_refs:["caller:caller-1"]}}});
    const d=decisionFixture(p,{spoken_response:"Soalan asal tentang status tempahan.",authoritative_facts_used:["caller:caller-1"],memory_update:{objective:{text:prior.transcript,evidence_quote:prior.transcript,source_refs:["caller:caller-1"]},corrections:[],open_questions:[]}});
    expect(validateCallingDecision(d,p,current)).toEqual({ok:false,reason:"unsupported_memory"});
    const repaired=reconstructCallingMemory(d,p,"unsupported_memory")!;
    expect(repaired.memory_update.objective).toBeNull();
    expect(repaired.authoritative_facts_used).toEqual(["caller:caller-1"]);
    expect(p.current_call.objective).toBe(prior.transcript);
    expect(validateCallingDecision(repaired,p,current).ok).toBe(true);
  });
  it("allows exact current memory directly and restricts model generation to packet IDs/quotes", () => {
    const p=packetFixture(transcripts[0]); const d=decisionFixture(p,{memory_update:{objective:memory(p),corrections:[],open_questions:[]}});
    expect(validateCallingDecision(d,p,current).ok).toBe(true);
    const schema=callingGenerationSchema(p);
    const generated={...d,memory_update:{objective:{evidence_quote:p.current_call.current_caller.transcript},corrections:[],open_questions:[]}};
    expect(schema.safeParse(generated).success).toBe(true);
    const bound=bindCallingGeneratedDecision(generated,p);
    expect(bound.memory_update).toEqual(d.memory_update);expect(validateCallingDecision(bound,p,current).ok).toBe(true);
    expect(schema.safeParse({...generated,authoritative_facts_used:["invented"]}).success).toBe(false);
    expect(schema.safeParse(malformedMemory(p)).success).toBe(false);
    expect(schema.safeParse({...generated,generation:"old-generation"}).success).toBe(false);
  });
  it.each(["Saya akan hantar quotation.", "Quotation dah dihantar.", "Pihak agensi akan uruskan.", "Quotation sudah dibaca."])("memory reconstruction never authorizes unsafe speech: %s", speech => {
    const p=packetFixture();const d={...malformedMemory(p),spoken_response:speech};
    const repaired=reconstructCallingMemory(d,p,"unsupported_memory")!;
    expect(validateCallingDecision(repaired,p,current).ok).toBe(false);
    const safe=callingContractRecovery(p);
    expect(safe.action_required).toBe(false);expect(safe.spoken_response).not.toBe(speech);
    expect(validateCallingDecision(safe,p,current).ok).toBe(true);
  });
  it.each([{...current,cancelled:true},{...current,live:false},{...current,generation:"new"},{...current,revision:3}])("does not repair stale ownership %j", ownership => {
    const p=packetFixture();const d=malformedMemory(p);
    expect(validateCallingDecision(d,p,ownership)).toEqual({ok:false,reason:"stale_decision"});
    expect(reconstructCallingMemory(d,p,"stale_decision")).toBeNull();
    expect(validateCallingDecision(callingContractRecovery(p),p,ownership).ok).toBe(false);
  });
  it("gives a useful verified payment response after an internal failure", () => {
    const p=packetFixture("Status tempahan saya?");const safe=callingContractRecovery(p);
    expect(safe.spoken_response).toBe("Rekod tempahan menunjukkan deposit sudah dibayar.");
    expect(safe.claim_requests).toEqual([{kind:"business_status",source_ref:"bookings:booking:deposit_paid",spoken_span:safe.spoken_response}]);
    expect(validateCallingDecision(safe,p,current).ok).toBe(true);
  });
  it("reuses an answered record-selection question on the next correction without selecting the newest record", () => {
    const records=recordsFixture();records.quotations.push({id:"other",quotation_number:"Q-2026-9999",status:"pending",updated_at:"2026-09-11"});
    records.bookings.push({id:"other-booking",quotation_id:"other",status:"pending",deposit_paid:false});
    const missing=packetFixture("Status tempahan saya?",records);
    const ask=callingContractRecovery(missing);expect(ask.clarification?.fact).toBe("booking_reference");
    expect(ask.spoken_response.match(/\?/g)).toHaveLength(1);expect(validateCallingDecision(ask,missing,current).ok).toBe(true);
    const prior={...callerFixture("Quotation Q-2026-0007 saya."),id:"reference-answer",sequence:1};
    const p=packetFixture("Tadi saya sudah beritahu.",records,{callers:[prior,callerFixture("Tadi saya sudah beritahu.")]});
    expect(p.business.selected_booking).toBe("booking");expect(p.business.selected_quotation).toBe("quote");expect(p.dialogue!.missing).toBeNull();
    const reply=callingContractRecovery(p);expect(reply.spoken_response).toContain("deposit sudah dibayar");expect(reply.spoken_response).not.toContain("?");
  });
  it("does not let a repeated question escape clarification policy by labelling it ANSWER", () => {
    const p=packetFixture(transcripts[3]);
    expect(validateCallingDecision(decisionFixture(p,{interaction_mode:"ANSWER",spoken_response:"Boleh ulang soalan tadi?"}),p,current))
      .toEqual({ok:false,reason:"unclassified_question"});
    const safe=callingContractRecovery(p);expect(safe.spoken_response).not.toContain("?");
  });
  it("bounds local reconstruction cost without invoking any provider", () => {
    const p=packetFixture(transcripts[0]);const d=malformedMemory(p); const samples:number[]=[];
    for(let i=0;i<200;i++){const start=performance.now();const r=reconstructCallingMemory(d,p,"unsupported_memory");expect(validateCallingDecision(r,p,current).ok).toBe(true);samples.push(performance.now()-start);}
    samples.sort((a,b)=>a-b);
    console.log(JSON.stringify({local_repair_samples:samples.length,p50_ms:samples[99],p95_ms:samples[189],max_ms:samples.at(-1),additional_model_calls:0}));
  });
});

const meta:EngineMetadata={configured_provider:"fixture",configured_model:"unchanged",returned_provider:null,returned_model:"unchanged",started_at:new Date().toISOString(),completed_at:new Date().toISOString(),latency_ms:1,input_tokens:100,output_tokens:20,fallback:false,cancellation:null};
const stores:Array<Awaited<ReturnType<typeof bridgeBusiness>> & {retained:Promise<unknown>[]}> = [];
afterEach(async()=>{for(const f of stores.splice(0)){await Promise.all(f.retained);await f.pg.close();}vi.clearAllMocks();});
async function runtime(ambiguous=true){
  const f=await bridgeBusiness();const retained:Promise<unknown>[]=[];stores.push(Object.assign(f,{retained}));
  const duplicate="77777777-7777-4777-8777-777777777777";
  if(ambiguous) await f.pg.query("INSERT INTO leads(id,agency_id,phone,full_name,do_not_contact) VALUES($1,$2,'60123456789','Other Contact',false)",[duplicate,binding.agencyId]);
  let text=transcripts[0]!;
  let decide:(p:CognitivePacket)=>Promise<unknown>=async p=>malformedMemory(p);
  const model=vi.fn(async({packet}:{packet:CognitivePacket})=>({decision:await decide(packet),metadata:meta}));
  const present=vi.fn(async(text:string)=>({text,replyOggBase64:null,voiceId:"locked",languageBoost:"Malay"}));
  const args={db:f.db,binding,lifetime:{retain:(p:Promise<unknown>)=>{retained.push(p);}},callerPhone:"60123456789",language:"ms-MY",agencyName:"Synthetic",disclosureSpoken:false,
    voiceId:"locked",languageBoost:()=>"Malay",present,engine:{decide:model},asr:async()=>({text,language:"ms",durationSeconds:1,confidence:"unknown" as const,provider:"fixture",model:"fixture"})};
  let previous=0;
  const turn=(sequence:number,signal=new AbortController().signal)=>handleCognitiveVoiceTurn({...args,receivedAt:Date.now(),signal,
    payload:{call_id:binding.callId,sequence,kind:sequence===1?"greeting":"utterance",duration_ms:1000,audio_ogg_base64:sequence===1?null:btoa(`audio${sequence}`),
      ...(previous?{media_metrics:{prev_sequence:previous,playback_complete_ms:1000}}:{})}});
  const wire=async(sequence:number)=>{const response=await callingTurnResponse({streaming:true,signal:new AbortController().signal,run:async()=> (await turn(sequence))!});
    const frames=(await response.text()).trim().split("\n").filter(Boolean).map(s=>JSON.parse(s));await Promise.all(retained);previous=sequence;return frames.at(-1);};
  const snapshot=()=>f.rpc("calling_bridge_snapshot",bindingArgs(binding));
  return {...f,retained,duplicate,turn,wire,model,present,snapshot,setText:(s:string)=>{text=s;},setDecision:(fn:typeof decide)=>{decide=fn;}};
}

describe("latest Founder call through the real bridge and PostgreSQL guards", () => {
  it("replays all seven exact transcripts, with one specific identity question and a correct farewell", async()=>{
    const f=await runtime();await f.wire(1);
    const sequences=[2,4,5,6,8,9,10];const spoken:string[]=[];
    for(let i=0;i<transcripts.length;i++){
      f.setText(transcripts[i]!);
      f.setDecision(async p=>{
        if(i===6)return decisionFixture(p,{intent:"farewell",interaction_mode:"CLOSE",completion_intent:"confirmed",next_state:"farewell_committed",spoken_response:"Sama-sama, terima kasih. Assalamualaikum!"});
        if(i===2)return decisionFixture(p,{authoritative_facts_used:["leads:invented:full_name"],spoken_response:"Maksudnya macam mana ya?"});
        if(i===5)return callingContractRecovery(p);
        return {...malformedMemory(p),spoken_response:"Maaf, saya nak pastikan saya faham betul. Maksudnya macam mana ya?"};
      });
      const frame=await f.wire(sequences[i]!);expect(frame.type).toBe("final");spoken.push(frame.speech_text);
      expect(frame.end_call).toBe(i===6);
    }
    expect(f.model).toHaveBeenCalledTimes(7);
    expect(spoken.some(s=>/maksudnya macam mana/i.test(s))).toBe(false);
    expect(spoken.filter(s=>s.includes("?")).length).toBe(1);
    expect(spoken[0]).toContain("Apakah nama penuh yang digunakan untuk tempahan itu?");
    expect(spoken[3]).toContain("Maaf, saya tersalah faham tadi.");
    expect(spoken[3]).toContain("status tempahan");expect(spoken[3]).not.toContain("?");
    const s=await f.snapshot();expect(s.callers.sort((a:{sequence:number},b:{sequence:number})=>a.sequence-b.sequence).map((c:{transcript:string})=>c.transcript)).toEqual(transcripts);
    expect(s.closing_state).toBe("farewell_committed");expect(s.farewell_id).toBeTruthy();
    const proposals=s.events.filter((e:{kind:string})=>e.kind==="proposal");
    expect(proposals.find((e:{sequence:number})=>e.sequence===2).payload).toMatchObject({failure_classification:"CONTRACT_FAILURE",response_classification:"GENUINE_CLARIFICATION_REQUIRED",contract_repair:{attempts:1,reason:"unsupported_memory"}});
    expect(proposals.find((e:{sequence:number})=>e.sequence===5).payload.contract_repair.reason).toBe("invented_source");
    expect(proposals.filter((e:{payload:{contract_repair:unknown}})=>e.payload.contract_repair).every((e:{payload:{contract_repair:{attempts:number}}})=>e.payload.contract_repair.attempts===1)).toBe(true);
    expect(proposals.every((e:{payload:{lead_id:unknown;conversation_id:unknown}})=>!e.payload.lead_id&&!e.payload.conversation_id)).toBe(true);
    expect(s.memory.objective.text).toBe(transcripts[0]);
    expect(s.memory.corrections.some((c:{text:string})=>c.text===transcripts[3])).toBe(true);
    expect((await f.pg.query("SELECT full_name FROM leads WHERE id=$1",[businessIds.lead])).rows[0].full_name).toBe("Dato’ Synthetic");
    expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_actions")).rows[0].n).toBe(0);expect(send).not.toHaveBeenCalled();
  });
  it("never converts a supplied name into authorization, then reuses the existing verified resolver",async()=>{
    const f=await runtime();await f.wire(1);expect((await f.wire(2)).speech_text).toContain("nama penuh");
    f.setText("Nama saya Dato Synthetic.");f.setDecision(async p=>decisionFixture(p,{spoken_response:"Tempahan sudah disahkan."}));
    const unverified=await f.wire(3);
    expect(unverified.speech_text).toContain("Apakah nombor rujukan sebut harga yang diterima daripada agensi?");
    expect(unverified.speech_text.match(/\?/g)).toHaveLength(1);
    expect(unverified.speech_text).not.toMatch(/nama penuh|Tempahan sudah disahkan|macam mana/);
    expect(f.model.mock.calls.at(-1)![0].packet.person.identity_refs).toEqual([]);
    // Simulate independent authoritative resolution in the isolated fixture, not through a spoken-name write.
    await f.pg.query("DELETE FROM leads WHERE id=$1",[f.duplicate]);
    f.setText("Status tempahan saya?");f.setDecision(async p=>decisionFixture(p,{spoken_response:"Saya dengar soalan tentang tempahan tadi."}));
    for(const seq of [4,5]){expect((await f.wire(seq)).speech_text).not.toContain("?");expect(f.model.mock.calls.at(-1)![0].packet.person.identity_refs).toHaveLength(1);}
  });
  it("keeps the offered question across the bounded snapshot window without asking again",async()=>{
    const f=await runtime();await f.wire(1);await f.wire(2);
    f.setText("Saya sudah beritahu tadi.");
    for(let seq=3;seq<=15;seq++)expect((await f.wire(seq)).speech_text).not.toContain("?");
    expect((await f.snapshot()).events.some((e:{sequence:number})=>e.sequence===2)).toBe(false);
    f.setText("Saya nak tahu status tempahan saya.");expect((await f.wire(16)).speech_text).not.toContain("?");
  });
  it("bounds an unreconstructable decision to one local attempt and zero additional model calls",async()=>{
    const f=await runtime(false);await f.wire(1);f.setText("Apa khabar?");
    f.setDecision(async p=>decisionFixture(p,{authoritative_facts_used:["invented"],spoken_response:"Maksudnya macam mana ya?"}));
    const response=await f.wire(2);expect(response.speech_text).toBe("Saya sedia membantu, terima kasih kerana bertanya.");
    expect(f.model).toHaveBeenCalledTimes(1);
    const telemetry=(await f.snapshot()).events.find((e:{kind:string;sequence:number})=>e.kind==="telemetry"&&e.sequence===2).payload;
    expect(telemetry.contract_repair).toMatchObject({attempts:1,reason:"invented_source",outcome:"safe_response"});
    expect(telemetry.timings.contract_repair_end).toBeGreaterThanOrEqual(telemetry.timings.contract_repair_start);
  });
  it("does not repair or commit an old generation after a newer turn is admitted",async()=>{
    const f=await runtime(false);await f.wire(1);let release!:()=>void, started!:()=>void;
    const ready=new Promise<void>(r=>{started=r;}),wait=new Promise<void>(r=>{release=r;});
    f.setDecision(async p=>{if(p.identity.sequence===2){started();await wait;return malformedMemory(p);}return decisionFixture(p);});
    const old=f.turn(2);await ready;f.setText("Saya ada soalan baru.");await f.wire(3);release();
    expect(await old).toMatchObject({ok:false,reason:"cognitive_stale_turn"});await Promise.all(f.retained);
    expect((await f.snapshot()).events.some((e:{sequence:number;kind:string})=>e.sequence===2&&e.kind==="proposal")).toBe(false);
    expect(f.model).toHaveBeenCalledTimes(2);expect(send).not.toHaveBeenCalled();
  });
});
