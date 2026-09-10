import { buildCognitivePacket, type BridgeSnapshot, type CallingRecords } from "../../src/lib/calls/cognitive-state.server";
import { BRIDGE_VERSION, type CognitiveDecision } from "../../src/lib/calls/cognitive-bridge.contract";
import { binding, receivedAt } from "./calling-bridge-db";
export const callerFixture = (text = "Awak sihat ke?") => ({ id: "caller-2", agency_id: binding.agencyId, session_id: binding.sessionId, sequence: 2,
  generation: "generation-2", transcript: text, received_at: receivedAt, asr_completed_at: receivedAt, persisted_at: receivedAt,
  language: "ms", duration_ms: 1500, confidence: "unknown" as const, channel: "whatsapp_calling" as const });
export const recordsFixture = (): CallingRecords => ({ lead: { id: "lead", full_name: "Dato' Amin", phone: "60123456789", do_not_contact: false,
  preferred_language: "ms", stage: "pending", pax: 3, package_interest: "Umrah", updated_at: receivedAt }, identityConflict: false,
  conversations: [{ id: "conversation", ai_enabled: true, human_attention_required: false }],
  quotations: [{ id: "quote", quotation_number: "Q-2026-0007", status: "deposit_paid", total: 29400, number_of_pilgrims: 3, customer_name: "Amin", updated_at: receivedAt }],
  bookings: [{ id: "booking", quotation_id: "quote", status: "deposit_paid", deposit_paid: true, amount_myr: 29400, balance_myr: 24400, pax: 3, updated_at: receivedAt }],
  messages: [], previousCalls: [] });
export function packetFixture(text = "Awak sihat ke?", records = recordsFixture(), extra: Partial<BridgeSnapshot> = {}) {
  const caller = callerFixture(text);
  const snapshot: BridgeSnapshot = { live: true, revision: 2, generation: caller.generation, current_sequence: 2, closing_state: "active",
    closing_episode: null, closing_clarifications: 0, farewell_id: null, memory: {}, callers: [caller], events: [], ...extra };
  return buildCognitivePacket({ binding, sequence: 2, caller, records, snapshot, language: "ms-MY", now: receivedAt });
}
export function decisionFixture(packet = packetFixture(), overrides: Partial<CognitiveDecision> = {}): CognitiveDecision {
  return { decision_version: BRIDGE_VERSION, packet_id: packet.packet_id, input_revision: packet.identity.input_revision,
    caller_turn_id: packet.identity.caller_turn_id, generation: packet.identity.generation, intent: "social", intent_confidence: 0.92,
    interaction_mode: "SOCIAL", understanding: "Caller asks how I am.", authoritative_facts_used: [], uncertainties: [],
    requires_clarification: false, response_strategy: "Respond reciprocally and truthfully.", action_required: false, requested_action: null,
    allowed_tool: null, requires_confirmation: false, completion_intent: "none", memory_update: { objective: null, corrections: [], open_questions: [] },
    next_state: "active", spoken_response: "Saya sedia membantu. Dato' pula macam mana hari ini?", claim_requests: [], decision_summary: "Reciprocal social response.", ...overrides };
}
