export type CognitiveChannel = "calling" | "whatsapp_text" | "whatsapp_voice_note";

export type CognitiveHistoryTurn = {
  role: "customer" | "assistant";
  text: string;
  sequence?: number;
};

export type CognitiveEvidence = {
  ref: string;
  source: string;
  authority: string;
  verification: string;
  disclosure: "continuity" | "private" | "unknown";
  observed_at: string;
  value: unknown;
};

export type CognitiveRequest = {
  request_id: string;
  tenant_id: string;
  relationship_ref: string | null;
  conversation_id: string | null;
  channel: CognitiveChannel;
  transcript: string;
  history: CognitiveHistoryTurn[];
  relationship_memory: CognitiveEvidence[];
  business_state: Record<string, unknown>;
  authorized_capabilities: string[];
  privacy: {
    recognition: "recognized" | "unrecognized";
    disclosure: "public_only" | "scope_authorized";
    authorized_scopes: string[];
  };
  locale: string;
  trace: {
    call_id: string;
    sequence: number;
    generation: string;
    turn_id: string;
  };
};

export type CognitiveResponse = {
  response_id: string;
  semantic_answer: string;
  resolved_identity_refs: string[];
  conversational_intent: string[];
  facts_used: string[];
  required_next_step: string | null;
  action_intents: string[];
  clarification_required: boolean;
  clarification_reason: string | null;
  disclosure_requirements: string[];
  semantic_units: Array<{
    kind: "answer" | "next_step" | "closure" | "explanation";
    text: string;
  }>;
  timing: {
    started_at: string;
    completed_at: string;
    reasoning_ms: number;
  };
};

export function isCognitiveResponse(value: unknown): value is CognitiveResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.semantic_answer === "string"
    && Array.isArray(v.resolved_identity_refs)
    && Array.isArray(v.conversational_intent)
    && Array.isArray(v.facts_used)
    && Array.isArray(v.action_intents)
    && typeof v.clarification_required === "boolean"
    && Array.isArray(v.disclosure_requirements)
    && Array.isArray(v.semantic_units);
}
