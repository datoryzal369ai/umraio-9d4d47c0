import { z } from "zod";
import type { CallingBinding, CallerTurn } from "./caller-turn-ledger.server";

export const BRIDGE_VERSION = "calling-cognitive-v1" as const;
export type ClosingState = "active" | "possible_completion" | "farewell_committed" | "terminal";
export type Evidence = {
  id: string; value: unknown;
  source: { kind: "record" | "caller" | "playback" | "message" | "action_receipt" | "runtime"; table: string; record_id: string; field: string };
  observed_at: string; recorded_at: string | null;
  authority: "business_record" | "verified_identity" | "caller_statement" | "delivered_speech" | "verified_execution" | "historical_claim" | "runtime";
  verification: "verified" | "stated" | "unverified" | "unknown" | "conflicted";
  conflicts: string[];
};
export type AdvisoryEnvelope = { version: string; source: string; observed_at: string; expiry: string;
  confidence: number | null; advisory: unknown };
export type ClarificationFact = "caller_identity" | "booking_reference" | "caller_request" | "completion";
// An offered question is conversation bookkeeping, never proof of identity or delivery.
export type ClarificationOffer = { key: string; fact: ClarificationFact; sequence: number };
export type CallingDialogue = {
  topic: "booking" | "general"; correction: boolean; source_refs: string[];
  offered: ClarificationOffer[];
  missing: { key: string; fact: ClarificationFact; question: string; offered: boolean; response_received: boolean } | null;
};
export type CognitivePacket = {
  version: typeof BRIDGE_VERSION; packet_id: string; built_at: string;
  identity: CallingBinding & { sequence: number; caller_turn_id: string; input_revision: number; generation: string };
  evidence: Evidence[];
  person: { identity_refs: string[]; honorific_ref: string | null; language: string; register: string; relationship_refs: string[] };
  business: { booking_refs: string[]; quotation_refs: string[]; traveller_refs: string[]; package_refs: string[];
    selected_booking: string | null; selected_quotation: string | null; state_complete: boolean };
  current_call: { current_caller: CallerTurn; caller_refs: string[]; delivered_assistant_refs: string[];
    objective: string | null; open_questions: string[]; corrections: string[];
    objective_ref: string | null; open_question_refs: string[]; correction_refs: string[]; unresolved_turns: number[]; missing_sequences: number[] };
  cross_channel_refs: string[];
  open_commitment_refs: string[];
  available_actions: Array<{ tool: "deliver_existing_quotation_whatsapp"; quotation_id: string; lead_id: string;
    conversation_id: string; recipient: "verified_caller_whatsapp"; evidence_refs: string[] }>;
  action_result_refs: string[];
  uncertainties: Array<{ id: string; kind: string; detail: string; evidence_refs: string[]; blocking: boolean }>;
  closing: { state: ClosingState; episode_id: string | null; clarification_count: number; farewell_id: string | null };
  dialogue?: CallingDialogue;
  renagi: null;
};

const short = z.string().max(500);
const refs = z.array(z.string().min(1).max(200)).max(20);
const memoryItem = z.object({ text: short, evidence_quote: short, source_refs: refs }).strict();
export const cognitiveDecisionSchema = z.object({
  decision_version: z.literal(BRIDGE_VERSION), packet_id: z.string().min(1), input_revision: z.number().int().nonnegative(),
  caller_turn_id: z.string().min(1), generation: z.string().min(1),
  intent: z.string().min(1).max(80), intent_confidence: z.number().min(0).max(1),
  interaction_mode: z.enum(["SOCIAL", "ANSWER", "CLARIFY", "RETRIEVE", "EXECUTE", "CONTINUE", "CLOSE"]),
  understanding: short,
  authoritative_facts_used: refs,
  uncertainties: z.array(z.object({ detail: short, source_refs: refs }).strict()).max(8),
  requires_clarification: z.boolean(), response_strategy: short, action_required: z.boolean(),
  clarification: z.object({ fact: z.enum(["caller_identity", "booking_reference", "caller_request", "completion"]), key: z.string().min(1).max(500) }).strict().nullable().optional(),
  requested_action: z.object({ name: z.literal("deliver_existing_quotation_whatsapp"), quotation_id: z.string().min(1),
    evidence_quote: short }).strict().nullable(),
  allowed_tool: z.literal("deliver_existing_quotation_whatsapp").nullable(), requires_confirmation: z.boolean(),
  completion_intent: z.enum(["none", "possible", "confirmed"]),
  memory_update: z.object({ objective: memoryItem.nullable(), corrections: z.array(memoryItem).max(4),
    open_questions: z.array(memoryItem).max(4) }).strict(),
  next_state: z.enum(["active", "possible_completion", "farewell_committed"]),
  spoken_response: z.string().min(1).max(1600),
  claim_requests: z.array(z.object({ kind: z.enum(["business_status", "identity", "execution_sent", "execution_read", "commitment"]),
    source_ref: z.string().min(1).max(200), spoken_span: z.string().min(1).max(500) }).strict()).max(12),
  decision_summary: short,
}).strict();
export type CognitiveDecision = z.infer<typeof cognitiveDecisionSchema>;

/** Constrain construction, not just the later veto. No generated IDs or memory paraphrases. */
export function callingGenerationSchema(packet: CognitivePacket) {
  const source = z.enum(packet.evidence.map(e => e.id) as [string, ...string[]]);
  const boundRefs = z.array(source).max(20);
  const text = packet.current_call.current_caller.transcript;
  const quotes = [...new Set([...(text.length <= 500 ? [text] : []),
    ...(text.match(/[^.!?\n]+[.!?]?/gu) ?? []).map(q => q.trim()).filter(q => q.length <= 500),
  ].filter(q => q.trim() && text.includes(q)))].slice(0, 16);
  const quote = z.enum((quotes.length ? quotes : [text.slice(0, 500)]) as [string, ...string[]]);
  // The model selects a quote. The application supplies both its identical text and canonical reference.
  const memory = z.object({ evidence_quote: quote }).strict();
  return cognitiveDecisionSchema.extend({
    packet_id: z.literal(packet.packet_id), input_revision: z.literal(packet.identity.input_revision),
    caller_turn_id: z.literal(packet.identity.caller_turn_id), generation: z.literal(packet.identity.generation),
    authoritative_facts_used: boundRefs,
    uncertainties: z.array(z.object({ detail: short, source_refs: boundRefs }).strict()).max(8),
    memory_update: z.object({ objective: memory.nullable(), corrections: z.array(memory).max(4), open_questions: z.array(memory).max(4) }).strict(),
    claim_requests: z.array(cognitiveDecisionSchema.shape.claim_requests.element.extend({ source_ref: source })).max(12),
  });
}

export function bindCallingGeneratedDecision(raw: unknown, packet: CognitivePacket): CognitiveDecision {
  const generated = callingGenerationSchema(packet).parse(raw);
  const bind = (item: { evidence_quote: string }) => ({ text: item.evidence_quote, evidence_quote: item.evidence_quote,
    source_refs: [`caller:${packet.identity.caller_turn_id}`] });
  return { ...generated, memory_update: {
    objective: generated.memory_update.objective ? bind(generated.memory_update.objective) : null,
    corrections: generated.memory_update.corrections.map(bind), open_questions: generated.memory_update.open_questions.map(bind),
  } };
}
export type EngineMetadata = { configured_provider: string; configured_model: string; returned_provider: string | null;
  returned_model: string | null; started_at: string; completed_at: string; latency_ms: number;
  input_tokens: number | null; output_tokens: number | null; fallback: boolean; cancellation: string | null };
export type CognitiveEngine = {
  decide(input: { packet: CognitivePacket; deadline: number; signal: AbortSignal }): Promise<{ decision: unknown; metadata: EngineMetadata }>;
};
/** Reserved compatibility vocabulary. v1 resolves only the unchanged current runtime configuration. */
export type FutureReasoningTier = "FAST_ECONOMICAL" | "STANDARD" | "DEEP" | "FRONTIER";
