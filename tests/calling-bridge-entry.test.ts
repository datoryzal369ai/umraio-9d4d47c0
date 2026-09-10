import { expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({asr:vi.fn(),decide:vi.fn(),legacyAsr:vi.fn()}));
vi.mock("@/lib/voice/asr.server",()=>({transcribeAudio:mocks.legacyAsr}));
vi.mock("@/lib/calls/caller-asr.server",()=>({transcribeCaller:mocks.asr}));
vi.mock("@/lib/calls/cognitive-engine.server",()=>({currentCallingEngine:{decide:mocks.decide}}));
import { handleVoiceTurn } from "../src/lib/calls/voice-turn.server";
import { callingTurnResponse } from "../src/lib/calls/call-stream.server";
import { callingLifetime } from "../src/lib/calls/calling-lifetime.server";
import { bridgeBusiness } from "./helpers/calling-bridge-business";
import { binding } from "./helpers/calling-bridge-db";
import { decisionFixture } from "./helpers/calling-cognitive-fixtures";
it.each(["answered", "meta_pre_accepted"])("actual voice-turn entry admits accepted %s using the existing Worker request retention capability",async status=>{
 mocks.asr.mockClear();mocks.decide.mockClear();mocks.legacyAsr.mockClear();
 const f=await bridgeBusiness(); const retained:Promise<unknown>[]=[];
 await f.pg.query("UPDATE whatsapp_call_sessions SET status=$1 WHERE id=$2",[status,binding.sessionId]);
 const request=new Request("https://synthetic.test/api/public/voice/turn") as Request & {waitUntil:(p:Promise<unknown>)=>void};
 request.waitUntil=p=>{retained.push(p);};
 const lifetime=callingLifetime(request);
 const run=async(sequence:number)=>{
  const response=await callingTurnResponse({streaming:true,signal:request.signal,run:(onAcknowledgement,signal)=>handleVoiceTurn({db:f.db,
    payload:{call_id:binding.callId,sequence,kind:sequence===1?"greeting":"utterance",audio_ogg_base64:sequence===1?null:btoa("synthetic"),duration_ms:1000},
    lifetime,onAcknowledgement,signal})});
  const rows=(await response.text()).trim().split("\n").map(s=>JSON.parse(s));await Promise.all(retained);return rows;
 };
 try{
  mocks.asr.mockResolvedValue({text:"Awak sihat ke?",language:"ms",durationSeconds:1,confidence:"unknown",provider:"fixture",model:"unchanged"});
  mocks.decide.mockImplementation(async({packet})=>({decision:decisionFixture(packet,{spoken_response:"Saya AI, sedia membantu. Awak pula?"}),metadata:null}));
  const greeting=(await run(1)).at(-1);
  expect(greeting.speech_text).toMatch(/RAIŌ|RAI.O|UMRAIO/i);
  expect(greeting.reason).not.toBe("cognitive_terminal");
  expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_sessions WHERE session_id=$1",[binding.sessionId])).rows[0].n).toBe(1);
  expect((await f.pg.query("SELECT status FROM whatsapp_call_sessions WHERE id=$1",[binding.sessionId])).rows[0].status).toBe(status);
  expect((await f.pg.query("SELECT count(*)::int n FROM calling_bridge_events WHERE session_id=$1 AND kind='handoff'",[binding.sessionId])).rows[0].n).toBe(1);
  const response=await run(2);expect(response.at(-1).speech_text).toContain("Saya AI");
  expect(mocks.asr).toHaveBeenCalledTimes(1);expect(mocks.decide).toHaveBeenCalledTimes(1);expect(mocks.legacyAsr).not.toHaveBeenCalled();
  expect((await f.pg.query("SELECT count(*)::int n FROM calling_caller_turns")).rows[0].n).toBe(1);
 }finally{await Promise.all(retained);await f.pg.close();}
});
it("stream handoff is denied when eligibility becomes stale and never serializes internal ownership hooks",async()=>{
 const handoff=vi.fn();const response=await callingTurnResponse({streaming:true,signal:new AbortController().signal,
  run:async()=>({ok:true,text:"stale goodbye",replyOggBase64:null,endCall:true,speechEligibility:async()=>false,onHandoff:handoff})});
 expect(await response.text()).toBe("");expect(handoff).not.toHaveBeenCalled();
});
