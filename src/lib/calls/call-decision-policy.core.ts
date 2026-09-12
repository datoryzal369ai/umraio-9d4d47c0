import { cognitiveDecisionSchema, type CognitiveDecision, type CognitivePacket } from "./cognitive-bridge.contract";
import { claimsSupported, callingContractRecovery } from "./call-speech-claims.core";
import { requestsQuotationSend, protectBookingAuthority } from "./call-executive.core";

/** Safety vetoes only. Ordinary intent and completion are decided semantically. */
export function closeVeto(text: string): boolean {
  return /\b(?:jangan(?:lah)?|tak payah|tak usah|belum|do not|don['’]?t)\b[^.!?]{0,45}\b(?:putus\w*|tamat\w*|hang\s?up|end|letak)\b/i.test(text)
    || /\b(?:kenapa|mengapa|why)\b[^.!?]{0,45}\b(?:terputus|disconnect\w*|putus)\b/i.test(text)
    || /\b(?:tadi|earlier|just now)\b[^.!?]{0,35}\b(?:terputus|disconnect\w*)\b|\b(?:terputus|disconnect\w*)\b[^.!?]{0,30}\b(?:tadi|earlier|just now)\b/i.test(text)
    || /\bputuskan\b[^.!?]{0,30}\b(?:tempahan|booking|jumlah|bayaran|payment)\b/i.test(text);
}

export function validateCallingDecision(raw: unknown, packet: CognitivePacket, current: {
  revision: number; generation: string; live: boolean; cancelled: boolean;
}): { ok: true; decision: CognitiveDecision } | { ok: false; reason: string } {
  const parsed = cognitiveDecisionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_contract" };
  const d = parsed.data;
  if (!current.live || current.cancelled || packet.closing.state === "terminal"
    || d.packet_id !== packet.packet_id || d.caller_turn_id !== packet.identity.caller_turn_id
    || d.input_revision !== packet.identity.input_revision || d.input_revision !== current.revision
    || d.generation !== packet.identity.generation || d.generation !== current.generation) return { ok: false, reason: "stale_decision" };
  const byId = new Map(packet.evidence.map(item => [item.id, item]));
  const allRefs = [...d.authoritative_facts_used, ...d.uncertainties.flatMap(u => u.source_refs),
    ...(d.memory_update.objective?.source_refs ?? []), ...d.memory_update.corrections.flatMap(m => m.source_refs),
    ...d.memory_update.open_questions.flatMap(m => m.source_refs), ...d.claim_requests.map(c => c.source_ref)];
  if (allRefs.some(id => !byId.has(id))) return { ok: false, reason: "invented_source" };
  if (d.authoritative_facts_used.some(id => ["unverified", "unknown", "conflicted"].includes(byId.get(id)!.verification))) return { ok: false, reason: "unverified_fact" };
  const currentText = packet.current_call.current_caller.transcript;
  for (const item of [d.memory_update.objective, ...d.memory_update.corrections, ...d.memory_update.open_questions]) {
    if (item && (item.text !== item.evidence_quote || !item.evidence_quote.trim() || !currentText.includes(item.evidence_quote)
      || !item.source_refs.includes(`caller:${packet.identity.caller_turn_id}`))) return { ok: false, reason: "unsupported_memory" };
  }
  if (/\b(?:maksudnya macam mana|what did you mean|could you clarify what you need)\b/i.test(d.spoken_response))
    return { ok: false, reason: "generic_clarification" };
  if (d.spoken_response.includes("?") && (d.interaction_mode !== "SOCIAL" || packet.dialogue?.correction)
    && !d.requires_clarification && d.interaction_mode !== "CLOSE")
    return { ok: false, reason: "unclassified_question" };
  if (d.requires_clarification && d.interaction_mode !== "CLARIFY") return { ok: false, reason: "clarification_required" };
  if (d.interaction_mode === "CLARIFY" || d.clarification) {
    const missing = packet.dialogue?.missing;
    if (!missing || !d.requires_clarification || d.interaction_mode !== "CLARIFY"
      || d.clarification?.fact !== missing.fact || d.clarification.key !== missing.key
      || !d.spoken_response.endsWith(missing.question) || (d.spoken_response.match(/\?/g) ?? []).length !== 1)
      return { ok: false, reason: "clarification_not_specific" };
    if (missing.offered || missing.response_received) return { ok: false, reason: "duplicate_clarification" };
  }
  // Identity ambiguity cannot be resolved by model prose or a caller's unverified spoken name.
  // It blocks PRIVATE answers only: an answer that neither cites a customer/booking record nor
  // asserts a business/identity claim exposes nothing, so ordinary conversation and general
  // package questions continue naturally instead of collapsing to the same identity sentence.
  if (packet.dialogue?.missing?.fact === "caller_identity" && d.interaction_mode !== "CLOSE"
    && d.spoken_response !== callingContractRecovery(packet).spoken_response) {
    const exposesRecord = d.authoritative_facts_used.some(id => ["business_record", "verified_identity", "verified_execution"]
      .includes(byId.get(id)?.authority ?? ""))
      || d.claim_requests.some(c => ["business_status", "identity", "execution_sent", "execution_read"].includes(c.kind));
    if (exposesRecord) return { ok: false, reason: "identity_not_verified" };
  }
  if (d.action_required) {
    const action = packet.available_actions.find(a => a.tool === d.allowed_tool && a.quotation_id === d.requested_action?.quotation_id);
    if (!action || d.interaction_mode !== "EXECUTE" || d.requires_clarification || d.requires_confirmation
      || d.uncertainties.length || packet.uncertainties.some(u => u.blocking) || d.intent_confidence < 0.8
      || !d.requested_action?.evidence_quote || !currentText.includes(d.requested_action.evidence_quote)
      || !requestsQuotationSend(currentText)) return { ok: false, reason: "action_not_authorized" };
  } else if (d.requested_action || d.allowed_tool || d.interaction_mode === "EXECUTE") return { ok: false, reason: "inconsistent_action" };
  if (d.interaction_mode === "CLOSE") {
    if (closeVeto(currentText) || d.completion_intent !== "confirmed" || d.next_state !== "farewell_committed"
      || d.requires_clarification || d.action_required || d.intent_confidence < 0.8
      || packet.closing.state === "farewell_committed") return { ok: false, reason: "close_not_authorized" };
    if (/\?|anything else|apa.?apa lagi/i.test(d.spoken_response)) return { ok: false, reason: "farewell_question" };
    const lastDelivered = packet.evidence.filter(e => packet.current_call.delivered_assistant_refs.includes(e.id)).at(-1)?.value as { closing_question?: boolean } | undefined;
    if (/^\s*(?:ok(?:ay)?|baik|ya|yes)[.!\s]*$/i.test(currentText) && lastDelivered?.closing_question !== true) return { ok: false, reason: "ambiguous_completion" };
  } else if (d.next_state === "farewell_committed" || d.completion_intent === "confirmed") return { ok: false, reason: "invalid_close_transition" };
  if (d.next_state === "possible_completion" && packet.closing.clarification_count >= 1) return { ok: false, reason: "duplicate_closing_clarification" };
  const payment = packet.evidence.find(e => e.id === `bookings:${packet.business.selected_booking}:deposit_paid`);
  if (payment?.value === true && protectBookingAuthority(d.spoken_response, { booking: { deposit_paid: true } }, packet.person.language) !== d.spoken_response) return { ok: false, reason: "contradicts_payment_record" };
  if (!claimsSupported(d, packet)) return { ok: false, reason: "unsupported_claim" };
  return { ok: true, decision: d };
}

/** Allowlisted failure paths only: no rejected text, evidence values or hidden model reasoning. */
export function callingValidationFields(raw: unknown, packet: CognitivePacket, reason: string): string[] {
  const parsed = cognitiveDecisionSchema.safeParse(raw);
  if (!parsed.success) return ["decision_schema"];
  const d = parsed.data;
  const ids = new Set(packet.evidence.map(e => e.id));
  const fields: string[] = [];
  const refs = (path: string, values: string[]) => { if (values.some(id => !ids.has(id))) fields.push(path); };
  refs("authoritative_facts_used", d.authoritative_facts_used);
  d.uncertainties.forEach((u,i) => refs(`uncertainties.${i}.source_refs`, u.source_refs));
  d.claim_requests.forEach((c,i) => refs(`claim_requests.${i}.source_ref`, [c.source_ref]));
  const memory = (path: string, item: NonNullable<CognitiveDecision["memory_update"]["objective"]>) => {
    refs(`${path}.source_refs`, item.source_refs);
    if (reason !== "unsupported_memory") return;
    if (item.text !== item.evidence_quote) fields.push(`${path}.text_quote_equality`);
    if (!item.evidence_quote.trim() || !packet.current_call.current_caller.transcript.includes(item.evidence_quote)) fields.push(`${path}.current_caller_quote`);
    if (!item.source_refs.includes(`caller:${packet.identity.caller_turn_id}`)) fields.push(`${path}.current_caller_reference`);
  };
  if (d.memory_update.objective) memory("memory_update.objective", d.memory_update.objective);
  d.memory_update.corrections.forEach((m,i) => memory(`memory_update.corrections.${i}`, m));
  d.memory_update.open_questions.forEach((m,i) => memory(`memory_update.open_questions.${i}`, m));
  return fields.length ? fields.slice(0, 12) : ["decision_policy"];
}
