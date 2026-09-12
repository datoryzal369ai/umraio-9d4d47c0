import { bindingArgs, callingRpc, retainCallerTurn, type CallingBinding, type CallingDb, type TurnLease } from "./caller-turn-ledger.server";
import { transcribeCaller, type CallerAsr } from "./caller-asr.server";
import { boundedCallingDb } from "./calling-db-lifetime.server";
import { retainBounded, withinCallingBudget, type CallingLifetime } from "./calling-lifetime.server";
import { buildCognitivePacket, includeRequestedQuotation, loadCallingRecords, continueCallingIdentity, callingSelectionText, nextClarificationOffers, priorClarificationOffers, type BridgeSnapshot } from "./cognitive-state.server";
import { currentCallingEngine, CallingEngineFailure, callingEngineFailureEvidence, reconstructCallingMemory, type CallingEngineFailureEvidence } from "./cognitive-engine.server";
import { BRIDGE_VERSION, type CognitiveDecision, type CognitiveEngine, type CognitivePacket, type EngineMetadata, type ClarificationOffer } from "./cognitive-bridge.contract";
import { validateCallingDecision, callingValidationFields } from "./call-decision-policy.core";
import { callingRecovery, callingContractRecovery } from "./call-speech-claims.core";
import { executeCallingDecision } from "./calling-action-lifecycle.server";
import { quotationDeliveryReply } from "./call-quotation.server";
import { acknowledgementOptions } from "./call-executive.core";
import { buildCallOpening } from "./call-experience.core";
import { resolveAddress } from "./cognitive-router.core";
import { callingSpokenText, withCallingBackchannel } from "./call-backchannel.core";
import { resolveQuotationContinuity, type CallQuotationCandidate, type QuotationContinuityHistoryTurn } from "./quotation-continuity.core";
import { detectSpokenLanguage, type VoiceTurnRequest } from "./voice-turn.core";
import type { VoiceTurnResult } from "./voice-turn.server";
import type { CallingAcknowledgement } from "./call-stream.server";

type Presentation = { text: string; replyOggBase64: string | null; voiceId: string; languageBoost: string };
const failure = (reason: string): VoiceTurnResult => ({ ok: false, reason });
const ACTIVE_QUOTATION_STATUS = new Set(["ready", "sent", "viewed", "discussing", "accepted", "deposit_pending"]);

function bridgeQuotationHistory(state: BridgeSnapshot): QuotationContinuityHistoryTurn[] {
  return state.events
    .filter(e => typeof e.payload?.text === "string")
    .sort((a, b) => a.sequence - b.sequence)
    .map(e => ({ role: "umraio" as const, text: String(e.payload.text) }));
}

function bridgeQuotationCandidates(records: { quotations: any[]; lead: any }): CallQuotationCandidate[] {
  return records.quotations
    .filter(q => !q.status || ACTIVE_QUOTATION_STATUS.has(String(q.status)))
    .slice(0, 5)
    .map(q => {
      const snapshot = q.package_snapshot && typeof q.package_snapshot === "object" ? q.package_snapshot : {};
      return {
        quotationNumber: typeof q.quotation_number === "string" ? q.quotation_number : null,
        packageName: snapshot.name ?? snapshot.package_name ?? records.lead?.package_interest ?? null,
        travelDate: snapshot.travel_date ?? snapshot.departure_date ?? q.travel_month ?? null,
        pax: Number(q.number_of_pilgrims ?? records.lead?.pax) || null,
      };
    });
}

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
  let contractRepair: { attempts: number; reason: string; fields: string[]; outcome: string } | null = null;
  let engineFailure: CallingEngineFailureEvidence | null = null;
  let enginePacket: CognitivePacket | null = null;
  let engineAnswerReceived = false;
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
        let clarificationOffers: ClarificationOffer[] = priorClarificationOffers(state, args.payload.sequence);
        let nextState: "active" | "possible_completion" | "farewell_committed" = "active";
        if (args.payload.kind === "greeting") {
          spoken = buildCallOpening({ agencyName: args.agencyName, language, disclosureAlreadySpoken: args.disclosureSpoken,
            knownName: address.spoken, variant: Array.from(args.binding.callId).reduce((sum, c) => sum + c.charCodeAt(0), 0) }).text;
        } else if (!records || !lease.turn) {
          recovery = "context_unavailable"; spoken = callingRecovery(language, "unavailable");
        } else {
          records = await continueCallingIdentity(db, records, args.binding, state, lease.turn, response);
          const requested = callingSelectionText(state, lease.turn.transcript);
          records = await includeRequestedQuotation(db, records, args.binding, requested, response);

          const quotationRecovery = resolveQuotationContinuity({
            transcript: lease.turn.transcript,
            history: bridgeQuotationHistory(state),
            recognizedCaller: Boolean(records.lead),
            leadResolved: Boolean(records.lead),
            conversationLinked: records.conversations.length === 1,
            candidates: bridgeQuotationCandidates(records),
            packageInterest: typeof records.lead?.package_interest === "string" ? records.lead.package_interest : null,
            pax: Number(records.lead?.pax) || null,
          });

          if (quotationRecovery) {
            spoken = quotationRecovery.reply;
          } else {
            const packet = buildCognitivePacket({ binding: args.binding, sequence: args.payload.sequence,
              snapshot: state, caller: lease.turn, records, language });
            packetId = packet.packet_id;
            clarificationOffers = nextClarificationOffers(packet, null);
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
              enginePacket = packet;
              times["model_start"] = Date.now();
              const model = (args.engine ?? currentCallingEngine).decide({ packet, deadline: args.receivedAt + 16_000, signal: response })
                .finally(() => { pending = false; times["model_end"] = Date.now(); });
              const result = await withCallingBackchannel({ answer: model, signal: response, emit });
              engineAnswerReceived = true;
              metadata = result.answer.metadata;
              state = await snapshot();
              times["policy_start"] = Date.now();
              let validated = validateCallingDecision(result.answer.decision, packet, { ...state, cancelled: response.aborted });
              times["policy_end"] = Date.now();
              if (!validated.ok) {
                if (validated.reason === "stale_decision") return failure("cognitive_stale_turn");
                recovery = validated.reason;
                contractRepair = { attempts: 1, reason: validated.reason,
                  fields: callingValidationFields(result.answer.decision, packet, validated.reason), outcome: "blocked" };
                times["contract_repair_start"] = Date.now();
                // Exactly one bounded local repair. No second reasoning call, ASR, context query or action.
                const reconstructed = reconstructCallingMemory(result.answer.decision, packet, validated.reason);
                const repaired = reconstructed ? validateCallingDecision(reconstructed, packet, { ...state, cancelled: response.aborted }) : null;
                if (repaired?.ok) { validated = repaired; contractRepair.outcome = "evidence_bound"; }
                else {
                  // Failed repair does not release any unvalidated model speech. Construct a fresh, safe response.
                  validated = validateCallingDecision(callingContractRecovery(packet), packet, { ...state, cancelled: response.aborted });
                  contractRepair.outcome = validated.ok ? "safe_response" : "blocked";
                }
                times["contract_repair_end"] = Date.now();
              }
              if (!validated.ok) return failure(validated.reason === "stale_decision" ? "cognitive_stale_turn" : "cognitive_contract_blocked");
              {
                decision = validated.decision;
                spoken = decision.spoken_response; nextState = decision.next_state;
                clarificationOffers = nextClarificationOffers(packet, decision);
                if (decision.action_required) {
                  pending = true;
                  const executing = executeCallingDecision({ db: args.db, binding: args.binding, packet, decision,
                    lifetime: args.lifetime, responseSignal: response, timings: times }).finally(() => { pending = false; });
                  const outcome = await withCallingBackchannel({ answer: executing, signal: response, emit });
                  spoken = quotationDeliveryReply(outcome.answer, language);
                }
              }
            } catch (error) {
              if (error instanceof CallingEngineFailure) { metadata = error.metadata; engineFailure = error.failure; }
              response.throwIfAborted();
              recovery = "engine_or_execution_unavailable";
              state = await snapshot();
              const safe = validateCallingDecision(callingContractRecovery(packet), packet, { ...state, cancelled: response.aborted });
              if (!safe.ok) return failure(safe.reason === "stale_decision" ? "cognitive_stale_turn" : "cognitive_contract_blocked");
              decision = safe.decision; spoken = decision.spoken_response; nextState = decision.next_state;
              clarificationOffers = nextClarificationOffers(packet, decision);
            } finally { pending = false; await ackWork; }
          }
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
            } : null, recovery, contract_repair: contractRepair, engine_failure: engineFailure,
            identity_continuation: records?.identityContinuation ?? null,
            failure_classification: contractRepair ? "CONTRACT_FAILURE" : recovery ? "AVAILABILITY_FAILURE" : null,
            response_classification: decision?.requires_clarification ? "GENUINE_CLARIFICATION_REQUIRED" : "ANSWER_OR_ACT",
            clarification: decision?.clarification ?? null, clarification_offers: clarificationOffers },
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
    // The response budget can reject before the engine's abort handler settles. Retain that known boundary
    // without delaying teardown for the model or pretending the provider itself reported an error.
    if (!engineFailure && cancellation && enginePacket && !engineAnswerReceived) {
      engineFailure = await callingEngineFailureEvidence(error, "engine_wait", enginePacket, args.signal,
        Date.now() - times["model_start"]!);
    }
    return failure(cancellation ?? "cognitive_turn_unavailable");
  } finally {
    if (lease?.state === "admitted") {
      times["response_complete"] = Date.now();
      // Media timings describe the previous sequence. Absence is unknown, never inferred playback.
      void record("telemetry", { version: BRIDGE_VERSION, packet_id: packetId, revision: lease.revision,
        generation: lease.generation, timings: times, engine: metadata, engine_failure: engineFailure,
        asr_runtime: asrRuntime, recovery, cancellation, contract_repair: contractRepair,
        media_evidence: args.payload.media_metrics ?? null, speech_end_timestamp: null,
        playback: "requires_gateway_evidence" }).catch(() => undefined);
    }
  }
}
