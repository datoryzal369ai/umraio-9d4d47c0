import { bindingArgs, callingRpc, retainCallerTurn, type CallingBinding, type CallingDb, type TurnLease } from "./caller-turn-ledger.server";
import { transcribeCaller, type CallerAsr } from "./caller-asr.server";
import { boundedCallingDb } from "./calling-db-lifetime.server";
import { retainBounded, withinCallingBudget, type CallingLifetime } from "./calling-lifetime.server";
import { buildCognitivePacket, includeRequestedQuotation, loadCallingRecords, type BridgeSnapshot } from "./cognitive-state.server";
import { currentCallingEngine, CallingEngineFailure } from "./cognitive-engine.server";
import { BRIDGE_VERSION, type CognitiveDecision, type CognitiveEngine, type EngineMetadata } from "./cognitive-bridge.contract";
import { validateCallingDecision } from "./call-decision-policy.core";
import { callingRecovery } from "./call-speech-claims.core";
import { executeCallingDecision } from "./calling-action-lifecycle.server";
import { quotationDeliveryReply } from "./call-quotation.server";
import { acknowledgementOptions } from "./call-executive.core";
import { buildCallOpening } from "./call-experience.core";
import { resolveAddress } from "./cognitive-router.core";
import { callingSpokenText, withCallingBackchannel } from "./call-backchannel.core";
import { detectSpokenLanguage, type VoiceTurnRequest } from "./voice-turn.core";
import type { VoiceTurnResult } from "./voice-turn.server";
import type { CallingAcknowledgement } from "./call-stream.server";

type Presentation = { text: string; replyOggBase64: string | null; voiceId: string; languageBoost: string };
const failure = (reason: string): VoiceTurnResult => ({ ok: false, reason });

/** Calling owns evidence, execution and speech eligibility; the engine owns none of them. */
export async function handleCognitiveVoiceTurn(args: {
  db: CallingDb; binding: CallingBinding; payload: VoiceTurnRequest; lifetime: CallingLifetime;
  signal: AbortSignal; receivedAt: number; callerPhone: string; language: string; agencyName: string | null;
  disclosureSpoken: boolean; voiceId: string; languageBoost: (language: string) => string;
  present: (text: string, language: string) => Promise<Presentation>;
  onAcknowledgement?: ((ack: CallingAcknowledgement) => void) | undefined;
  engine?: CognitiveEngine; asr?: (bytes: Uint8Array, signal: AbortSignal) => Promise<CallerAsr>;
}): Promise<VoiceTurnResult | null> {
  const times: Record<string, number> = { received: args.receivedAt };
  let lease: TurnLease | undefined;
  let metadata: EngineMetadata | null = null;
  let asrRuntime: {provider: string; model: string} | null = null;
  let packetId: string | null = null;
  let recovery: string | null = null;
  let cancellation: string | null = null;
  const base = bindingArgs(args.binding);
  const record = (kind: string, payload: Record<string, unknown>) => retainBounded(args.lifetime, 3000, owner =>
    callingRpc(args.db, "calling_bridge_record", { ...base, p_sequence: args.payload.sequence,
      p_generation: lease!.generation, p_revision: lease!.revision, p_kind: kind, p_payload: payload }, owner));
  try {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
      kind: args.payload.kind, audio: args.payload.audio_ogg_base64, duration: args.payload.duration_ms,
    })));
    // Neither audio nor digest is logged; it prevents conflicting retries silently overwriting a sequence.
    const digest = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
    return await withinCallingBudget(args.signal, Math.max(1, 19_000 - (Date.now() - args.receivedAt)), async response => {
      const db = boundedCallingDb(args.db, response);
      const snapshot = () => callingRpc<BridgeSnapshot>(db, "calling_bridge_snapshot", base, response);
      times["context_start"] = Date.now();
      // Handle the error in this same owned task even if ASR/caller persistence fails first.
      const recordsPromise = loadCallingRecords(db, { binding: args.binding, callerPhone: args.callerPhone, signal: response })
        .then(records => { times["context_end"] = Date.now(); return { records }; }, () => ({ records: null }));
      try {
        lease = await retainCallerTurn({ db: args.db, binding: args.binding, sequence: args.payload.sequence,
          greeting: args.payload.kind === "greeting", receivedAt: new Date(args.receivedAt).toISOString(),
          lifetime: args.lifetime, durationMs: args.payload.duration_ms, requestDigest: digest, timings: times,
          asr: async owner => {
            const binary = atob(args.payload.audio_ogg_base64 ?? "");
            const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
            if (!bytes.length) throw new Error("calling_invalid_audio");
            const result = await (args.asr ? args.asr(bytes, owner) : transcribeCaller({ bytes, language: args.language, signal: owner }));
            asrRuntime = {provider: result.provider, model: result.model};
            return result;
          },
        });
        if (lease.state === "legacy") return null;
        if (!lease.can_respond) return failure(`cognitive_${lease.state}`);
        response.throwIfAborted();
        if (args.payload.media_metrics) await callingRpc(db, "calling_bridge_observe_media", {
          ...base, p_sequence: args.payload.sequence, p_metrics: args.payload.media_metrics,
        }, response);
        let state = await snapshot();
        if (!state.live || state.generation !== lease.generation) return failure("cognitive_stale_turn");
        const uncertainActions = (state.actions ?? []).filter(a => ["claimed", "dispatching", "outcome_unknown"].includes(a.state));
        if (uncertainActions.length) {
          const reconciled = await Promise.all(uncertainActions.map(action => callingRpc<{ok:boolean}>(db, "calling_bridge_action", {
            ...base, p_sequence: args.payload.sequence, p_generation: lease!.generation, p_revision: lease!.revision,
            p_quotation: action.quotation_id, p_operation: "reconcile", p_result: {},
          }, response)));
          if (reconciled.some(r => r.ok)) state = await snapshot();
        }
        let { records } = await recordsPromise;
        const language = lease.turn ? detectSpokenLanguage(lease.turn.transcript, args.language) : args.language;
        const address = resolveAddress(records?.lead?.full_name);
        let spoken: string;
        let decision: CognitiveDecision | null = null;
        let nextState: "active" | "possible_completion" | "farewell_committed" = "active";
        if (args.payload.kind === "greeting") {
          spoken = buildCallOpening({ agencyName: args.agencyName, language, disclosureAlreadySpoken: args.disclosureSpoken,
            knownName: address.spoken, variant: Array.from(args.binding.callId).reduce((sum, c) => sum + c.charCodeAt(0), 0) }).text;
        } else if (!records || !lease.turn) {
          recovery = "context_unavailable"; spoken = callingRecovery(language, "unavailable");
        } else {
          const requested = /\bQ-[A-Z0-9]+-[A-Z0-9]+\b/i.test(lease.turn.transcript)
            ? lease.turn.transcript : state.memory.objective?.text ?? lease.turn.transcript;
          records = await includeRequestedQuotation(db, records, args.binding, requested, response);
          const packet = buildCognitivePacket({ binding: args.binding, sequence: args.payload.sequence,
            snapshot: state, caller: lease.turn, records, language });
          packetId = packet.packet_id;
          let pending = true;
          let ackWork: Promise<unknown> | undefined;
          let ackSent = false;
          // A neutral cached acknowledgement requires neither a classifier nor a fictitious lookup.
          const options = acknowledgementOptions(address, language).map(callingSpokenText);
          const acknowledgement = options[language.startsWith("en") ? 1 : 0]!;
          const previousAck = state.events.filter(e => e.kind === "acknowledgement").sort((a,b) => a.sequence - b.sequence).at(-1)?.payload.text;
          const emit = args.onAcknowledgement && previousAck !== acknowledgement ? () => {
            ackWork = (async () => {
              const current = await snapshot();
              if (ackSent || !pending || response.aborted || !current.live || current.generation !== lease!.generation) return;
              ackSent = true;
              args.onAcknowledgement?.({ text: acknowledgement, voiceId: args.voiceId, languageBoost: args.languageBoost(language) });
              times["ack_handoff"] = Date.now();
              await record("acknowledgement", { text: acknowledgement, delivery: "handoff_only" });
            })().catch(() => undefined);
          } : undefined;
          try {
            times["model_start"] = Date.now();
            const model = (args.engine ?? currentCallingEngine).decide({ packet, deadline: args.receivedAt + 16_000, signal: response })
              .finally(() => { pending = false; times["model_end"] = Date.now(); });
            const result = await withCallingBackchannel({ answer: model, signal: response, emit });
            metadata = result.answer.metadata;
            state = await snapshot();
            times["policy_start"] = Date.now();
            const validated = validateCallingDecision(result.answer.decision, packet, { ...state, cancelled: response.aborted });
            times["policy_end"] = Date.now();
            if (!validated.ok) {
              if (validated.reason === "stale_decision") return failure("cognitive_stale_turn");
              recovery = validated.reason; spoken = validated.reason === "duplicate_closing_clarification"
                ? (language.startsWith("en") ? "I am listening." : "Baik, saya dengar.") : callingRecovery(language);
            } else {
              decision = validated.decision;
              spoken = decision.spoken_response; nextState = decision.next_state;
              if (decision.action_required) {
                pending = true;
                const executing = executeCallingDecision({ db: args.db, binding: args.binding, packet, decision,
                  lifetime: args.lifetime, responseSignal: response, timings: times }).finally(() => { pending = false; });
                const outcome = await withCallingBackchannel({ answer: executing, signal: response, emit });
                spoken = quotationDeliveryReply(outcome.answer, language);
              }
            }
          } catch (error) {
            if (error instanceof CallingEngineFailure) metadata = error.metadata;
            response.throwIfAborted();
            recovery = "engine_or_execution_unavailable"; spoken = callingRecovery(language, "unavailable");
            decision = null; nextState = "active";
          } finally { pending = false; await ackWork; }
        }
        response.throwIfAborted();
        const presentation = await args.present(spoken, language);
        response.throwIfAborted();
        times["output_commit_start"] = Date.now();
        const output = await callingRpc<{ ok: boolean; reason?: string; farewell_id: string | null }>(db, "calling_bridge_output", {
          ...base, p_sequence: args.payload.sequence, p_generation: lease.generation, p_revision: lease.revision,
          p_payload: { text: presentation.text, next_state: nextState, language, greeting: args.payload.kind === "greeting",
            closing_question: nextState === "possible_completion", lead_id: records?.lead?.id ?? null,
            conversation_id: records?.conversations.length === 1 ? records.conversations[0].id : null, memory_update: decision?.memory_update ?? {},
            packet_id: packetId, decision_version: BRIDGE_VERSION, decision: decision ? {
              intent: decision.intent, interaction_mode: decision.interaction_mode, understanding: decision.understanding,
              authoritative_facts_used: decision.authoritative_facts_used, uncertainties: decision.uncertainties,
              completion_intent: decision.completion_intent, decision_summary: decision.decision_summary,
            } : null, recovery },
        }, response);
        if (!output.ok) return failure(output.reason ?? "cognitive_stale_output");
        times["output_commit_end"] = Date.now();
        return { ok: true, ...presentation, endCall: nextState === "farewell_committed",
          ...(nextState === "farewell_committed" ? { reason: "conversation_complete" } : {}),
          ...(args.payload.kind === "greeting" ? { backchannelTexts: acknowledgementOptions(address, language).map(callingSpokenText) } : {}),
          speechEligibility: () => withinCallingBudget(args.signal, 2500, async owner => {
            const current = await callingRpc<BridgeSnapshot>(args.db, "calling_bridge_snapshot", base, owner);
            return current.live && current.revision === lease!.revision && current.generation === lease!.generation
              && (nextState !== "farewell_committed" || current.farewell_id === output.farewell_id);
          }),
          onHandoff: () => { void record("handoff", {}).catch(() => undefined); },
        };
      } finally { await recordsPromise; }
    });
  } catch (error) {
    cancellation = args.signal.aborted ? "response_cancelled" : error instanceof DOMException && error.name === "TimeoutError" ? "processing_timeout" : null;
    return failure(cancellation ?? "cognitive_turn_unavailable");
  } finally {
    if (lease?.state === "admitted") {
      times["response_complete"] = Date.now();
      // Media timings describe the previous sequence. Absence is unknown, never inferred playback.
      void record("telemetry", { version: BRIDGE_VERSION, packet_id: packetId, revision: lease.revision,
        generation: lease.generation, timings: times, engine: metadata, asr_runtime: asrRuntime, recovery, cancellation,
        media_evidence: args.payload.media_metrics ?? null, speech_end_timestamp: null,
        playback: "requires_gateway_evidence" }).catch(() => undefined);
    }
  }
}
