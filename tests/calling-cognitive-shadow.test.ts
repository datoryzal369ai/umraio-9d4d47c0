import { describe, expect, it } from "vitest";
import { buildCallingShadowRequest, compareCallingCognition, immutableCallingTurnId } from "../src/lib/calls/cognitive-shadow.server";
import type { CognitiveDecision, CognitivePacket } from "../src/lib/calls/cognitive-bridge.contract";

const packet = {
  version: "calling-cognitive-v1",
  packet_id: "packet-1",
  built_at: "2026-09-12T00:00:00.000Z",
  identity: { agencyId: "agency-a", sessionId: "session-a", callId: "call-a", gatewaySessionId: "gw-a", sequence: 7, caller_turn_id: "turn-a", input_revision: 2, generation: "7" },
  evidence: [{ id: "runtime:whatsapp_recognition", value: { prior_interaction: true }, source: { kind: "runtime", table: "runtime", record_id: "recognition", field: "prior_interaction" }, observed_at: "2026-09-12T00:00:00.000Z", recorded_at: null, authority: "runtime", verification: "verified", conflicts: [] }],
  person: { identity_refs: [], honorific_ref: null, language: "ms-MY", register: "respectful", relationship_refs: ["lead:1"] },
  business: { booking_refs: [], quotation_refs: [], traveller_refs: [], package_refs: [], selected_booking: null, selected_quotation: null, state_complete: true },
  current_call: { current_caller: { id: "turn-a", agency_id: "agency-a", session_id: "session-a", sequence: 7, generation: "7", transcript: "Saya nak sambung yang WhatsApp tadi", received_at: "2026-09-12T00:00:00.000Z", asr_completed_at: "2026-09-12T00:00:00.100Z", persisted_at: "2026-09-12T00:00:00.200Z", language: "ms-MY", duration_ms: 1000, confidence: "unknown", channel: "whatsapp_calling" }, caller_refs: ["caller:turn-a"], delivered_assistant_refs: [], objective: null, open_questions: [], corrections: [], objective_ref: null, open_question_refs: [], correction_refs: [], unresolved_turns: [], missing_sequences: [] },
  cross_channel_refs: ["conversation:wa-1"], open_commitment_refs: [], available_actions: [], action_result_refs: [], uncertainties: [], closing: { state: "active", episode_id: null, clarification_count: 0, farewell_id: null }, dialogue: { topic: "general", correction: false, source_refs: [], offered: [], missing: null }, renagi: null,
} satisfies CognitivePacket;

const decision = {
  decision_version: "calling-cognitive-v1", packet_id: "packet-1", input_revision: 2, caller_turn_id: "turn-a", generation: "7",
  intent: "continue_conversation", intent_confidence: 0.9, interaction_mode: "CONTINUE", understanding: "Continue prior WhatsApp thread", authoritative_facts_used: ["runtime:whatsapp_recognition"], uncertainties: [], requires_clarification: false, response_strategy: "continue", action_required: false, clarification: null, requested_action: null, allowed_tool: null, requires_confirmation: false, completion_intent: "none", memory_update: { objective: null, corrections: [], open_questions: [] }, next_state: "active", spoken_response: "Baik Tuan, kita sambung yang tadi.", claim_requests: [], decision_summary: "Continue safely",
} satisfies CognitiveDecision;

describe("calling canonical cognition shadow", () => {
  it("uses an immutable call/sequence/generation turn identity", () => {
    expect(immutableCallingTurnId("call-a", 7, "7")).toBe("call:call-a:seq:7:gen:7");
  });

  it("builds a channel-neutral read-only request with no capabilities", () => {
    const request = buildCallingShadowRequest(packet);
    expect(request.channel).toBe("calling");
    expect(request.tenant_id).toBe("agency-a");
    expect(request.authorized_capabilities).toEqual([]);
    expect(request.privacy.disclosure).toBe("public_only");
    expect(request.trace.turn_id).toBe("call:call-a:seq:7:gen:7");
  });

  it("emits comparison classifications without raw transcript or answers", () => {
    const request = buildCallingShadowRequest(packet);
    const comparison = compareCallingCognition({ request, authoritative: decision, shadow: { ok: false, reason: "timeout", reasoning_ms: 4000 } });
    expect(comparison.shadow_failure_reason).toBe("timeout");
    expect(JSON.stringify(comparison)).not.toContain(packet.current_call.current_caller.transcript);
    expect(JSON.stringify(comparison)).not.toContain(decision.spoken_response);
  });
});
