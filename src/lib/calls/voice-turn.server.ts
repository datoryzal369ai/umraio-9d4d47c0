/**
 * UMRAIO® — 24/7 AI AUTONOMOUS EXECUTIVE VOICE™ (Phase 3, control plane).
 *
 * One live voice turn: caller audio -> ASR -> RÉNAIO.CORE™ -> RAIŌ™ voice ->
 * MiniMax TTS -> Opus back to the gateway. The media gateway holds no
 * credentials and no intelligence; every decision is made here.
 *
 * REALTIME EXPERIENCE (P0/P1):
 *  - RAIŌ speaks FIRST. The greeting + one-time recording disclosure is
 *    deterministic (FAST PATH), so first audio never waits on an LLM.
 *  - Cross-channel memory: the caller is resolved to the SAME lead and
 *    WhatsApp thread before reasoning, hydrated CONCURRENTLY with ASR.
 *  - Natural closing: a completion check and farewell come from the fast path
 *    state machine, not from a silence timeout.
 *  - Every turn records sanitized phase latency for the acceptance report.
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
import { languageBoostFor, MINIMAX_DEFAULT_VOICE_ID } from "@/lib/voice/minimax.server";
import { synthesizeCallSpeech } from "./call-audio.server";
import {
  advanceClosing,
  appendLatency,
  buildCallOpening,
  readClosingState,
  summarizeLatency,
  type TurnLatency,
} from "./call-experience.core";
import {
  adaptationInstruction,
  callerHasPendingWork,
  readSignals,
  updateSignals,
  type ConversationSignals,
} from "./renagi-signals.core";
import {
  EMPTY_CALLER_CONTEXT,
  hydrateCallerContext,
  persistCallMemory,
  type CallerContext,
} from "./call-context.server";

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
  MAX_STORED_TURNS,
  type VoiceIntentKey,
  type VoiceTranscriptTurn,
  type VoiceTurnRequest,
  type VoiceTurnSessionRow,
} from "./voice-turn.core";

type Db = { from: (table: string) => any };

export type VoiceTurnResult =
  | {
      ok: true;
      replyOggBase64: string | null;
      text: string;
      /** Locked MiniMax identity the media plane must speak with. */
      voiceId?: string;
      languageBoost?: string;
      endCall: boolean;
      reason?: string;
    }
  | { ok: false; reason: string };

/**
 * SPEECH OWNERSHIP — the serverless control plane cannot compile an Opus
 * encoder (Worker runtime forbids runtime WASM: probe `wasm_unavailable`), so
 * by default it returns TEXT and the media gateway performs MiniMax synthesis
 * + native libopus encoding next to the RTP sender. Set CALL_TTS_IN_WORKER=1
 * only on a Node-capable runtime that can actually encode Opus.
 */
function synthesizeInWorker(): boolean {
  return process.env["CALL_TTS_IN_WORKER"] === "1";
}

const SESSION_COLUMNS =
  "id, agency_id, call_id, caller_phone, status, meta_accepted_at, transcript, turn_count, detected_language, voice_intents, lead_id, conversation_id, closing_state, disclosure_spoken, voice_latency, renagi_signals";

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
  contextLines: string[];
  contextFacts: Record<string, unknown>;
  /** Style-only behaviour guidance from the internal perception layer. */
  behaviourLines: string[];
}): Promise<string | null> {
  const gateway = createIntelligenceGateway();
  const messages = args.history.slice(-8).map((turn) => ({
    role: turn.role === "customer" ? ("user" as const) : ("assistant" as const),
    content: turn.text,
  }));
  if (args.transcript) messages.push({ role: "user", content: args.transcript });

  const systemLines = [
    buildVoiceSystemPrompt({
      agencyName: args.agencyName,
      preferredLanguage: args.preferredLanguage,
      isGreeting: args.isGreeting,
      callerPhone: args.callerPhone,
    }),
    // AI SALES ELITE on the phone — a conversational move, never a script.
    "Sales behaviour: listen, qualify gently, build trust, address the concern actually raised,",
    "recommend only what the agency's real catalogue supports, and move to one clear next step.",
    "Never deliver a monologue and never repeat the caller's sentence back to them.",
    "Vary your openers — do not begin every turn with the same word.",
    "If the caller asks whether you are human, say plainly that you are RAIŌ, the UMRAIO AI executive.",
  ];
  if (args.behaviourLines.length) {
    systemLines.push("", ...args.behaviourLines);
  }
  if (args.contextLines.length) {
    systemLines.push("", "CUSTOMER RELATIONSHIP MEMORY (authoritative, never invent beyond it):", ...args.contextLines);
  }

  const result = await gateway.generate({
    taskType: "customer_reply",
    system: systemLines.join("\n"),
    prompt: args.isGreeting ? "Open the call now with your greeting." : args.transcript,
    ...(messages.length > 0 ? { messages } : {}),
    context: {
      agencyId: args.agencyId,
      correlationId: `voice:${args.callId}`,
      locale: args.language,
      now: new Date().toISOString(),
      facts: {
        channel: "whatsapp_voice_call",
        spoken: true,
        language: args.language,
        ...args.contextFacts,
      },
      allowedTools: [],
    },
  });
  const text = result.ok ? (result.data ?? "").trim() : "";
  return text.length > 0 ? text : null;
}

/** Compact post-call memory written back into the WhatsApp thread. */
function buildCallSummary(args: {
  turns: VoiceTranscriptTurn[];
  intents: VoiceIntentKey[];
  outcome: string;
  language: string;
}): string {
  const asked = args.turns
    .filter((t) => t.role === "customer")
    .slice(-4)
    .map((t) => `• ${t.text}`)
    .join("\n");
  return [
    "[Ringkasan panggilan RAIŌ]",
    `Bahasa: ${args.language}`,
    `Hasil: ${args.outcome}`,
    args.intents.length ? `Niat: ${args.intents.join(", ")}` : "",
    asked ? `Perkara dibincang:\n${asked}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  const startedAt = Date.now();

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
  const agencyName = ((agency as any)?.name as string | null) ?? null;
  const voicePersona = {
    persona: ((settings as any)?.voice_persona as string | null) ?? null,
    controls: ((settings as any)?.voice_controls as Record<string, unknown> | null) ?? null,
    voice: ((settings as any)?.voice_name as string | null) ?? null,
  };

  const history = readTranscript(row.transcript);
  let transcript = "";
  let language = row.detected_language ?? agencyLanguage;
  let asrMs = 0;
  let contextMs = 0;
  let reasoningMs = 0;
  let ttsMs = 0;
  let fastPath = false;

  // PRE-CALL / PARALLEL HYDRATION — cross-channel relationship memory is
  // fetched CONCURRENTLY with ASR so it never adds serial latency.
  const contextStartedAt = Date.now();
  const contextPromise: Promise<CallerContext> = hydrateCallerContext(db, {
    agencyId: row.agency_id,
    callerPhone: row.caller_phone,
  })
    .catch(() => EMPTY_CALLER_CONTEXT)
    .then((ctx) => {
      contextMs = Date.now() - contextStartedAt;
      return ctx;
    });

  // 1. ASR — the caller's real words, or nothing at all.
  if (payload.kind === "utterance") {
    const bytes = payload.audio_ogg_base64 ? base64ToBytes(payload.audio_ogg_base64) : null;
    if (!bytes) return { ok: false, reason: "invalid_audio" };

    // LOCALE LOCK — without an explicit hint the model auto-detected short
    // Malay utterances as Japanese/Spanish on the live call (transcript
    // evidence: "が。", "Sí."), so the agency voice locale is always sent.
    const asrStartedAt = Date.now();
    const asr = await transcribeAudio({ bytes, mimeType: "audio/ogg", language: agencyLanguage });
    asrMs = Date.now() - asrStartedAt;
    if (!asr.ok) {
      console.log(`[calls] voice_turn_asr_failed call_id=${payload.call_id} kind=${asr.kind}`);
      return { ok: false, reason: `asr_${asr.kind}` };
    }
    transcript = asr.text.trim();
    if (!transcript) return { ok: false, reason: "asr_empty_transcript" };
    language = detectSpokenLanguage(transcript, agencyLanguage);
  }

  const context = await contextPromise;

  // ROLLING PERCEPTION — incremental, deterministic, zero added latency. It
  // shapes HOW RAIŌ speaks; the decision itself stays with RÉNAIO.CORE™.
  const signals: ConversationSignals = updateSignals(readSignals(row.renagi_signals), transcript);
  const pendingWork = callerHasPendingWork(transcript);

  // 2. RESPONSE. Greeting and closing come from the FAST PATH (deterministic,
  //    no model round-trip); everything else goes to RÉNAIO.CORE™.
  const closingState = readClosingState(row.closing_state);
  let nextClosingState = closingState;
  let endCall = false;
  let replyText: string | null = null;

  if (payload.kind === "greeting") {
    const opening = buildCallOpening({
      agencyName,
      language,
      disclosureAlreadySpoken: row.disclosure_spoken === true,
      knownName: context.knownName,
    });
    replyText = opening.text;
    fastPath = true;
  } else {
    const closing = advanceClosing({
      state: closingState,
      transcript,
      language,
      turnCount: history.length,
      maxTurns: MAX_STORED_TURNS,
      // COMMON SENSE: never close while the caller still has business open.
      pendingWork,
    });
    nextClosingState = closing.state;
    if (closing.action !== "continue") {
      replyText = closing.text;
      fastPath = true;
      endCall = closing.action === "farewell";
    }
  }

  if (!replyText) {
    const reasoningStartedAt = Date.now();
    replyText = await reason({
      agencyId: row.agency_id,
      callId: row.call_id,
      agencyName,
      preferredLanguage: agencyLanguage,
      callerPhone: row.caller_phone,
      isGreeting: false,
      history,
      transcript,
      language,
      contextLines: context.promptLines,
      contextFacts: { ...context.facts, conversation_signals: signals },
      behaviourLines: adaptationInstruction(signals),
    });
    reasoningMs = Date.now() - reasoningStartedAt;
  }
  if (!replyText) {
    console.log(`[calls] voice_turn_reasoning_failed call_id=${payload.call_id}`);
    return { ok: false, reason: "reasoning_failed" };
  }

  // 3. RAIŌ™ voice presentation. Speech is rendered by the media plane with
  //    the LOCKED MiniMax identity unless a Node-capable runtime opts in.
  const spoken = prepareSpokenResponse({ replyText, language, persona: voicePersona });
  const speech = spoken.spokenText.trim() || replyText;
  let replyOggBase64: string | null = null;
  if (synthesizeInWorker()) {
    const ttsStartedAt = Date.now();
    const tts = await synthesizeCallSpeech({
      callId: payload.call_id,
      text: speech,
      language,
      voice: spoken.voice,
      speed: spoken.speed,
      instructions: spoken.instructions,
    });
    ttsMs = Date.now() - ttsStartedAt;
    if (!tts.ok) {
      return { ok: false, reason: tts.reason };
    }
    replyOggBase64 = bytesToBase64(tts.bytes);
  }

  // 4. CALL MEMORY — transcript, language, intents, outcome, latency.
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
  if (turns.length >= MAX_STORED_TURNS) endCall = true;

  const latencyEntry: TurnLatency = {
    seq: payload.sequence,
    kind: payload.kind,
    asr_ms: asrMs,
    context_ms: contextMs,
    reasoning_ms: reasoningMs,
    tts_ms: ttsMs,
    total_ms: Date.now() - startedAt,
    fast_path: fastPath,
  };
  const latency = appendLatency(row.voice_latency, latencyEntry);
  const outcome = deriveCallOutcome(intents, turns);
  // INCREMENTAL CALL MEMORY — the summary is refreshed on EVERY turn, so a
  // dropped call is still remembered. Only the end of call writes it across
  // into the WhatsApp thread.
  const summary = buildCallSummary({ turns, intents, outcome, language });

  await db
    .from("whatsapp_call_sessions")
    .update({
      transcript: turns,
      turn_count: (row.turn_count ?? 0) + 1,
      detected_language: language,
      voice_intents: intents,
      voice_outcome: outcome,
      closing_state: endCall ? "farewell" : nextClosingState,
      disclosure_spoken: row.disclosure_spoken === true || payload.kind === "greeting",
      voice_latency: latency,
      renagi_signals: signals,
      call_summary: summary,
      lead_id: row.lead_id ?? context.leadId,
      conversation_id: row.conversation_id ?? context.conversationId,
      ...(travellers ? { voice_traveller_count: travellers } : {}),
    })
    .eq("id", row.id);

  // CALL → TEXT continuity, written once at the natural end of the call.
  if (endCall) {
    await persistCallMemory(db, {
      agencyId: row.agency_id,
      conversationId: row.conversation_id ?? context.conversationId,
      summary,
    });
  }

  const stats = summarizeLatency(latency);
  console.log(
    `[calls] voice_turn_ok call_id=${payload.call_id} kind=${payload.kind} lang=${language} fast=${fastPath} ` +
      `asr=${asrMs}ms ctx=${contextMs}ms reason=${reasoningMs}ms tts=${ttsMs}ms total=${latencyEntry.total_ms}ms ` +
      `p50=${stats["p50_total_ms"]}ms p95=${stats["p95_total_ms"]}ms known_customer=${context.leadId ? "yes" : "no"} ` +
      `closing=${nextClosingState} pending=${pendingWork} intents=${intents.join("|") || "none"} end=${endCall}`,
  );

  return {
    ok: true,
    replyOggBase64,
    text: speech,
    // Voice identity travels with every reply so the media plane can never
    // speak with a substitute voice or a provider default.
    voiceId: MINIMAX_DEFAULT_VOICE_ID,
    languageBoost: languageBoostFor(language),
    endCall,
    ...(endCall ? { reason: "conversation_complete" } : {}),
  };
}
