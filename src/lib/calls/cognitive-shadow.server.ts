import { createIntelligenceGateway } from "@/lib/ai/gateway.server";
import { isCognitiveResponse, type CognitiveRequest, type CognitiveResponse } from "@/lib/ai/cognitive-contract.core";
import type { CognitiveDecision, CognitivePacket } from "./cognitive-bridge.contract";

export type ShadowFailureReason = "disabled" | "timeout" | "model_failure" | "invalid_response";

export type ShadowResult =
  | { ok: true; response: CognitiveResponse; reasoning_ms: number }
  | { ok: false; reason: ShadowFailureReason; reasoning_ms: number };

export type ShadowComparison = {
  turn_id: string;
  authoritative_intent: string;
  shadow_intent: string | null;
  authoritative_identity: "recognized" | "unrecognized";
  shadow_identity: "recognized" | "unrecognized" | null;
  authoritative_clarification_required: boolean;
  shadow_clarification_required: boolean | null;
  history_coverage_count: number;
  relationship_evidence_count: number;
  shadow_facts_count: number;
  required_next_step_match: boolean | null;
  action_intent_match: boolean | null;
  disclosure_result: "public_only" | "scope_authorized";
  semantic_difference: "equivalent" | "intent_changed" | "next_step_changed" | "meaning_changed" | "unavailable";
  authoritative_reasoning_ms: number | null;
  shadow_reasoning_ms: number;
  shadow_failure_reason: ShadowFailureReason | null;
};

export function immutableCallingTurnId(callId: string, sequence: number, generation: string): string {
  return `call:${callId}:seq:${sequence}:gen:${generation}`;
}

function disclosureClass(id: string): "continuity" | "private" | "unknown" {
  if (/booking|quotation|payment|traveller|identity/i.test(id)) return "private";
  if (/message|recognition|objective|question|correction/i.test(id)) return "continuity";
  return "unknown";
}

export function buildCallingShadowRequest(packet: CognitivePacket): CognitiveRequest {
  const turnId = immutableCallingTurnId(packet.identity.callId, packet.identity.sequence, packet.identity.generation);
  const recognized = packet.person.relationship_refs.length > 0 || packet.person.identity_refs.length > 0;
  const relationshipMemory = packet.evidence.slice(0, 40).map((item) => ({
    ref: item.id,
    source: `${item.source.kind}:${item.source.table}:${item.source.field}`,
    authority: item.authority,
    verification: item.verification,
    disclosure: disclosureClass(item.id),
    observed_at: item.observed_at,
    value: item.value,
  }));
  const history = packet.current_call.caller_refs.slice(-20).map((ref, index) => ({
    role: "customer" as const,
    text: ref,
    sequence: Math.max(0, packet.identity.sequence - (packet.current_call.caller_refs.length - index)),
  }));
  return {
    request_id: `shadow:${turnId}`,
    tenant_id: packet.identity.agencyId,
    relationship_ref: packet.person.relationship_refs[0] ?? packet.person.identity_refs[0] ?? null,
    conversation_id: packet.cross_channel_refs.find((ref) => /conversation/i.test(ref)) ?? null,
    channel: "calling",
    transcript: packet.current_call.current_caller.transcript,
    history,
    relationship_memory: relationshipMemory,
    business_state: {
      selected_booking: packet.business.selected_booking,
      selected_quotation: packet.business.selected_quotation,
      booking_refs: packet.business.booking_refs,
      quotation_refs: packet.business.quotation_refs,
      package_refs: packet.business.package_refs,
      open_commitment_refs: packet.open_commitment_refs,
      uncertainties: packet.uncertainties.map((u) => ({ kind: u.kind, blocking: u.blocking, evidence_refs: u.evidence_refs })),
    },
    authorized_capabilities: [],
    privacy: {
      recognition: recognized ? "recognized" : "unrecognized",
      disclosure: "public_only",
      authorized_scopes: [],
    },
    locale: packet.person.language,
    trace: {
      call_id: packet.identity.callId,
      sequence: packet.identity.sequence,
      generation: packet.identity.generation,
      turn_id: turnId,
    },
  };
}

function shadowSystem(): string {
  return [
    "You are RAIŌ canonical cognition running in READ-ONLY SHADOW MODE.",
    "Return JSON only. Never call tools. Never claim an action happened. Never mutate memory or business state.",
    "Reason across the supplied tenant-bound relationship context while respecting privacy metadata.",
    "Recognition is not authorization. Treat private facts as non-disclosable unless the request explicitly marks scope_authorized.",
    "Required JSON keys: semantic_answer, resolved_identity_refs, conversational_intent, facts_used, required_next_step, action_intents, clarification_required, clarification_reason, disclosure_requirements, semantic_units.",
  ].join("\n");
}

function responsePrompt(request: CognitiveRequest): string {
  return JSON.stringify(request);
}

export async function runCallingCognitionShadow(
  request: CognitiveRequest,
  timeoutMs = 4_000,
): Promise<ShadowResult> {
  if (process.env["CALL_COGNITION_SHADOW"] !== "1") return { ok: false, reason: "disabled", reasoning_ms: 0 };
  const started = Date.now();
  const gateway = createIntelligenceGateway();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      gateway.generate({
        taskType: "customer_reply",
        system: shadowSystem(),
        prompt: responsePrompt(request),
        context: {
          agencyId: request.tenant_id,
          correlationId: request.request_id,
          locale: request.locale,
          now: new Date().toISOString(),
          facts: { channel: "calling_shadow", request },
          allowedTools: [],
        },
      }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    const reasoningMs = Date.now() - started;
    if (result === null) return { ok: false, reason: "timeout", reasoning_ms: reasoningMs };
    if (!result.ok || !result.data) return { ok: false, reason: "model_failure", reasoning_ms: reasoningMs };
    let parsed: unknown;
    try { parsed = JSON.parse(result.data); }
    catch { return { ok: false, reason: "invalid_response", reasoning_ms: reasoningMs }; }
    if (!isCognitiveResponse(parsed)) return { ok: false, reason: "invalid_response", reasoning_ms: reasoningMs };
    const response: CognitiveResponse = {
      ...parsed,
      response_id: typeof parsed.response_id === "string" && parsed.response_id ? parsed.response_id : `response:${request.request_id}`,
      timing: {
        started_at: new Date(started).toISOString(),
        completed_at: new Date().toISOString(),
        reasoning_ms: reasoningMs,
      },
    };
    return { ok: true, response, reasoning_ms: reasoningMs };
  } catch {
    return { ok: false, reason: "model_failure", reasoning_ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase("ms").replace(/\s+/g, " ").trim();
}

function nextStepFromAuthoritative(decision: CognitiveDecision): string | null {
  return decision.clarification?.key ?? (decision.action_required ? decision.allowed_tool : null);
}

export function compareCognition(args: {
  request: CognitiveRequest;
  authoritative: CognitiveDecision;
  authoritativeReasoningMs: number | null;
  shadow: ShadowResult;
}): ShadowComparison {
  const response = args.shadow.ok ? args.shadow.response : null;
  const authoritativeIntent = args.authoritative.intent;
  const shadowIntent = response?.conversational_intent[0] ?? null;
  const authoritativeNext = nextStepFromAuthoritative(args.authoritative);
  const shadowNext = response?.required_next_step ?? null;
  let semanticDifference: ShadowComparison["semantic_difference"] = "unavailable";
  if (response) {
    if (normalize(authoritativeIntent) !== normalize(shadowIntent)) semanticDifference = "intent_changed";
    else if (normalize(authoritativeNext) !== normalize(shadowNext)) semanticDifference = "next_step_changed";
    else semanticDifference = "equivalent";
  }
  return {
    turn_id: args.request.trace.turn_id,
    authoritative_intent: authoritativeIntent,
    shadow_intent: shadowIntent,
    authoritative_identity: args.request.privacy.recognition,
    shadow_identity: response
      ? (response.resolved_identity_refs.length > 0 ? "recognized" : "unrecognized")
      : null,
    authoritative_clarification_required: args.authoritative.requires_clarification,
    shadow_clarification_required: response?.clarification_required ?? null,
    history_coverage_count: args.request.history.length,
    relationship_evidence_count: args.request.relationship_memory.length,
    shadow_facts_count: response?.facts_used.length ?? 0,
    required_next_step_match: response ? normalize(authoritativeNext) === normalize(shadowNext) : null,
    action_intent_match: response
      ? normalize(args.authoritative.allowed_tool) === normalize(response.action_intents[0] ?? null)
      : null,
    disclosure_result: args.request.privacy.disclosure,
    semantic_difference: semanticDifference,
    authoritative_reasoning_ms: args.authoritativeReasoningMs,
    shadow_reasoning_ms: args.shadow.reasoning_ms,
    shadow_failure_reason: args.shadow.ok ? null : args.shadow.reason,
  };
}
