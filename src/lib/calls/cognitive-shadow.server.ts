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

function parseResponse(raw: string, request: CognitiveRequest, startedAt: number, completedAt: number): CognitiveResponse | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidate = {
      ...parsed,
      response_id: typeof parsed.response_id === "string" ? parsed.response_id : `response:${request.request_id}`,
      timing: {
        started_at: new Date(startedAt).toISOString(),
        completed_at: new Date(completedAt).toISOString(),
        reasoning_ms: Math.max(0, completedAt - startedAt),
      },
    };
    return isCognitiveResponse(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export async function runCallingCognitionShadow(request: CognitiveRequest, timeoutMs = 4_000): Promise<ShadowResult> {
  if (process.env["CALL_COGNITION_SHADOW"] !== "1") return { ok: false, reason: "disabled", reasoning_ms: 0 };
  const startedAt = Date.now();
  const gateway = createIntelligenceGateway();
  const work = gateway.generate({
    taskType: "customer_reply",
    taskClass: "reasoning",
    system: shadowSystem(),
    prompt: JSON.stringify(request),
    context: {
      agencyId: request.tenant_id,
      correlationId: request.trace.turn_id,
      locale: request.locale,
      now: new Date().toISOString(),
      facts: { channel: request.channel, shadow: true, privacy: request.privacy },
      allowedTools: [],
    },
  }).then((result): ShadowResult => {
    const completedAt = Date.now();
    if (!result.ok || !result.data) return { ok: false, reason: "model_failure", reasoning_ms: completedAt - startedAt };
    const response = parseResponse(result.data, request, startedAt, completedAt);
    return response
      ? { ok: true, response, reasoning_ms: completedAt - startedAt }
      : { ok: false, reason: "invalid_response", reasoning_ms: completedAt - startedAt };
  }).catch((): ShadowResult => ({ ok: false, reason: "model_failure", reasoning_ms: Date.now() - startedAt }));
  const timeout = new Promise<ShadowResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, reason: "timeout", reasoning_ms: Date.now() - startedAt }), timeoutMs);
  });
  return Promise.race([work, timeout]);
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function compareCallingCognition(args: {
  request: CognitiveRequest;
  authoritative: CognitiveDecision;
  authoritativeReasoningMs?: number | null;
  shadow: ShadowResult;
}): ShadowComparison {
  const shadow = args.shadow.ok ? args.shadow.response : null;
  const authoritativeNext = args.authoritative.clarification?.key ?? null;
  const shadowNext = shadow?.required_next_step ?? null;
  const authoritativeActions = args.authoritative.requested_action ? [args.authoritative.requested_action.name] : [];
  const shadowActions = shadow?.action_intents ?? [];
  let semanticDifference: ShadowComparison["semantic_difference"] = "unavailable";
  if (shadow) {
    const intentMatch = shadow.conversational_intent.some((intent) => normalized(intent) === normalized(args.authoritative.intent));
    const nextMatch = normalized(authoritativeNext) === normalized(shadowNext);
    const answerMatch = normalized(shadow.semantic_answer) === normalized(args.authoritative.spoken_response);
    semanticDifference = intentMatch && nextMatch && answerMatch ? "equivalent"
      : !intentMatch ? "intent_changed"
      : !nextMatch ? "next_step_changed"
      : "meaning_changed";
  }
  return {
    turn_id: args.request.trace.turn_id,
    authoritative_intent: args.authoritative.intent,
    shadow_intent: shadow?.conversational_intent[0] ?? null,
    authoritative_identity: args.request.privacy.recognition,
    shadow_identity: shadow ? (shadow.resolved_identity_refs.length ? "recognized" : "unrecognized") : null,
    authoritative_clarification_required: args.authoritative.requires_clarification,
    shadow_clarification_required: shadow?.clarification_required ?? null,
    history_coverage_count: args.request.history.length,
    relationship_evidence_count: args.request.relationship_memory.length,
    shadow_facts_count: shadow?.facts_used.length ?? 0,
    required_next_step_match: shadow ? normalized(authoritativeNext) === normalized(shadowNext) : null,
    action_intent_match: shadow ? JSON.stringify([...authoritativeActions].sort()) === JSON.stringify([...shadowActions].sort()) : null,
    disclosure_result: args.request.privacy.disclosure,
    semantic_difference: semanticDifference,
    authoritative_reasoning_ms: args.authoritativeReasoningMs ?? null,
    shadow_reasoning_ms: args.shadow.reasoning_ms,
    shadow_failure_reason: args.shadow.ok ? null : args.shadow.reason,
  };
}
