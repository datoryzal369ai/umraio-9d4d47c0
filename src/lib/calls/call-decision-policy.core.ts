import { cognitiveDecisionSchema, type CognitiveDecision, type CognitivePacket } from "./cognitive-bridge.contract";
import { claimsSupported } from "./call-speech-claims.core";
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
    ...d.memory_update.open_questions.flatMap(m => m.source_refs)];
  if (allRefs.some(id => !byId.has(id))) return { ok: false, reason: "invented_source" };
  if (d.authoritative_facts_used.some(id => ["unverified", "unknown", "conflicted"].includes(byId.get(id)!.verification))) return { ok: false, reason: "unverified_fact" };
  const currentText = packet.current_call.current_caller.transcript;
  for (const item of [d.memory_update.objective, ...d.memory_update.corrections, ...d.memory_update.open_questions]) {
    if (item && (item.text !== item.evidence_quote || !item.evidence_quote.trim() || !currentText.includes(item.evidence_quote)
      || !item.source_refs.includes(`caller:${packet.identity.caller_turn_id}`))) return { ok: false, reason: "unsupported_memory" };
  }
  if (d.requires_clarification && d.interaction_mode !== "CLARIFY") return { ok: false, reason: "clarification_required" };
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
