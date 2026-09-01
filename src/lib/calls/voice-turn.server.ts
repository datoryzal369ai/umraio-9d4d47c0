/**
 * UMRAIO® — 24/7 AI AUTONOMOUS EXECUTIVE VOICE™ (Phase 3, control plane).
 *
 * One live voice turn: caller audio -> ASR -> RÉNAIO.CORE™ -> RAIŌ™ voice ->
 * MiniMax TTS -> Opus back to the gateway. The media gateway holds no
 * credentials and no intelligence; every decision is made here.
 *
 * FAIL CLOSED at every stage: a failed ASR returns no transcript, a failed
 * reasoning call returns no words, a failed TTS returns no audio. UMRAIO stays
 * silent rather than fabricating anything to a live caller.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createIntelligenceGateway } from "@/lib/ai/gateway.server";
import { transcribeAudio } from "@/lib/voice/asr.server";
import { resolveVoiceLanguage } from "@/lib/voice/language.core";
import { prepareSpokenResponse } from "@/lib/voice/tts.core";
import { synthesizeSpeech } from "@/lib/voice/tts.server";

import {
  appendTranscript,
  buildVoiceSystemPrompt,
  classifyVoiceIntents,
  deriveCallOutcome,
  detectSpokenLanguage,
  detectTravellerCount,
  gateVoiceTurn,
  mergeIntents,
  readTranscript,
  shouldEndCall,
  type VoiceIntentKey,
  type VoiceTranscriptTurn,
  type VoiceTurnRequest,
  type VoiceTurnSessionRow,
} from "./voice-turn.core";

type Db = { from: (table: string) => any };

export type VoiceTurnResult =
  | { ok: true; replyOggBase64: string | null; text: string; endCall: boolean; reason?: string }
  | { ok: false; reason: string };

const SESSION_COLUMNS =
  "id, agency_id, call_id, caller_phone, status, meta_accepted_at, transcript, turn_count, detected_language, voice_intents";

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out.byteLength > 0 ? out : null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Reasoning through the existing intelligence gateway (RÉNAIO.CORE™ seam). */
async function reason(args: {
  agencyId: string;
  callId: string;
  agencyName: string | null;
  preferredLanguage: string | null;
  callerPhone: string | null;
  isGreeting: boolean;
  history: VoiceTranscriptTurn[];
  transcript: string;
  language: string;
}): Promise<string | null> {
  const gateway = createIntelligenceGateway();
  const messages = args.history.slice(-8).map((turn) => ({
    role: turn.role === "customer" ? ("user" as const) : ("assistant" as const),
    content: turn.text,
  }));
  if (args.transcript) messages.push({ role: "user", content: args.transcript });

  const result = await gateway.generate({
    taskType: "customer_reply",
    system: buildVoiceSystemPrompt({
      agencyName: args.agencyName,
      preferredLanguage: args.preferredLanguage,
      isGreeting: args.isGreeting,
      callerPhone: args.callerPhone,
    }),
    prompt: args.isGreeting
      ? "Open the call now with your greeting."
      : args.transcript,
    ...(messages.length > 0 ? { messages } : {}),
    context: {
      agencyId: args.agencyId,
      correlationId: `voice:${args.callId}`,
      locale: args.language,
      now: new Date().toISOString(),
      facts: { channel: "whatsapp_voice_call", spoken: true, language: args.language },
      allowedTools: [],
    },
  });
  const text = result.ok ? (result.data ?? "").trim() : "";
  return text.length > 0 ? text : null;
}

/**
 * Handles exactly one HMAC-verified turn from the media gateway.
 * Tenancy is read from the Worker's own call-session row — never from the
 * gateway payload, which carries no agency identifier at all.
 */
export async function handleVoiceTurn(args: {
  db: Db;
  payload: VoiceTurnRequest;
  now?: () => Date;
}): Promise<VoiceTurnResult> {
  const { db, payload } = args;
  const now = args.now ?? (() => new Date());

  const { data } = await db
    .from("whatsapp_call_sessions")
    .select(SESSION_COLUMNS)
    .eq("call_id", payload.call_id)
    .maybeSingle();
  const session = (data as VoiceTurnSessionRow | null) ?? null;

  const gate = gateVoiceTurn(session);
  if (!gate.allow) {
    console.log(`[calls] voice_turn_rejected call_id=${payload.call_id} reason=${gate.reason}`);
    return { ok: false, reason: gate.reason };
  }
  const row = session!;

  // Agency voice configuration lives in agency_settings — the authoritative
  // store for voice_persona, voice_controls, voice_name and voice_language.
  // agency_id comes from the Worker's own session row, never from the client.
  const { data: settings } = await db
    .from("agency_settings")
    .select("voice_persona, voice_controls, voice_name, voice_language")
    .eq("agency_id", row.agency_id)
    .maybeSingle();
  const { data: agency } = await db
    .from("agencies")
    .select("name")
    .eq("id", row.agency_id)
    .maybeSingle();
  const agencyLanguage = resolveVoiceLanguage((settings as any)?.voice_language ?? null);
  const voicePersona = {
    persona: ((settings as any)?.voice_persona as string | null) ?? null,
    controls: ((settings as any)?.voice_controls as Record<string, unknown> | null) ?? null,
    voice: ((settings as any)?.voice_name as string | null) ?? null,
  };

  const history = readTranscript(row.transcript);
  let transcript = "";
  let language = row.detected_language ?? agencyLanguage;

  // 1. ASR — the caller's real words, or nothing at all.
  if (payload.kind === "utterance") {
    const bytes = payload.audio_ogg_base64 ? base64ToBytes(payload.audio_ogg_base64) : null;
    if (!bytes) return { ok: false, reason: "invalid_audio" };

    const asr = await transcribeAudio({ bytes, mimeType: "audio/ogg" });
    if (!asr.ok) {
      console.log(`[calls] voice_turn_asr_failed call_id=${payload.call_id} kind=${asr.kind}`);
      return { ok: false, reason: `asr_${asr.kind}` };
    }
    transcript = asr.text.trim();
    if (!transcript) return { ok: false, reason: "asr_empty_transcript" };
    language = detectSpokenLanguage(transcript, agencyLanguage);
  }

  // 2. REASONING — existing intelligence layer. No answer means no speech.
  const replyText = await reason({
    agencyId: row.agency_id,
    callId: row.call_id,
    agencyName: ((agency as any)?.name as string | null) ?? null,
    preferredLanguage: agencyLanguage,
    callerPhone: row.caller_phone,
    isGreeting: payload.kind === "greeting",
    history,
    transcript,
    language,
  });
  if (!replyText) {
    console.log(`[calls] voice_turn_reasoning_failed call_id=${payload.call_id}`);
    return { ok: false, reason: "reasoning_failed" };
  }

  // 3. RAIŌ™ voice presentation + MiniMax TTS. No audio means silence.
  const spoken = prepareSpokenResponse({ replyText, language, persona: voicePersona });
  const speech = spoken.spokenText.trim() || replyText;
  const tts = await synthesizeSpeech({
    text: speech,
    language,
    voice: spoken.voice,
    speed: spoken.speed,
    instructions: spoken.instructions,
  });
  if (!tts.ok) {
    console.log(`[calls] voice_turn_tts_failed call_id=${payload.call_id} kind=${tts.kind}`);
    return { ok: false, reason: `tts_${tts.kind}` };
  }
  if (!tts.mimeType.startsWith("audio/ogg")) {
    console.log(`[calls] voice_turn_tts_container_unsupported call_id=${payload.call_id}`);
    return { ok: false, reason: "tts_container_unsupported" };
  }

  // 4. CALL MEMORY — transcript, language, intents, outcome.
  const additions: VoiceTranscriptTurn[] = [];
  if (transcript) {
    additions.push({
      role: "customer",
      text: transcript,
      at: now().toISOString(),
      duration_ms: payload.duration_ms,
    });
  }
  additions.push({ role: "umraio", text: speech, at: now().toISOString() });

  const turns = appendTranscript(history, additions);
  const intents: VoiceIntentKey[] = mergeIntents(row.voice_intents, classifyVoiceIntents(transcript));
  const travellers = transcript ? detectTravellerCount(transcript) : null;
  const endCall = shouldEndCall(transcript, turns.length);

  await db
    .from("whatsapp_call_sessions")
    .update({
      transcript: turns,
      turn_count: (row.turn_count ?? 0) + 1,
      detected_language: language,
      voice_intents: intents,
      voice_outcome: deriveCallOutcome(intents, turns),
      ...(travellers ? { voice_traveller_count: travellers } : {}),
    })
    .eq("id", row.id);

  console.log(
    `[calls] voice_turn_ok call_id=${payload.call_id} kind=${payload.kind} lang=${language} intents=${intents.join("|") || "none"} end=${endCall}`,
  );

  return {
    ok: true,
    replyOggBase64: bytesToBase64(tts.bytes),
    text: speech,
    endCall,
    ...(endCall ? { reason: "conversation_complete" } : {}),
  };
}
