/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CallingBinding, CallingDb, CallerTurn } from "./caller-turn-ledger.server";
import { BRIDGE_VERSION, type CognitivePacket, type Evidence, type ClosingState } from "./cognitive-bridge.contract";
import { resolveAddress } from "./cognitive-router.core";
import { requestsQuotationSend } from "./call-executive.core";

type StoredMemory = { text: string; source_refs: string[]; observed_at?: string };
export type BridgeSnapshot = { live: boolean; revision: number; generation: string; current_sequence: number;
  closing_state: ClosingState; closing_episode: string | null; closing_clarifications: number; farewell_id: string | null;
  memory: { objective?: StoredMemory | null; corrections?: StoredMemory[]; open_questions?: StoredMemory[] };
  actions?: Array<{id: string; quotation_id: string; state: string; receipt: unknown; claimed_at: string; completed_at: string | null}>;
  callers: CallerTurn[]; events: Array<{ id: string; sequence: number; kind: string; payload: any; created_at: string }> };

const phone = (value: string) => { const d = value.replace(/\D/g, ""); return d.startsWith("0") ? `60${d.slice(1)}` : d; };
const rows = (result: any): any[] => { if (result.error) throw new Error(`calling_context_${result.error.code ?? "unavailable"}`); return Array.isArray(result.data) ? result.data : result.data ? [result.data] : []; };

/** Read only, tenant-scoped and bounded. No imports from any Voice Note implementation. */
export async function loadCallingRecords(db: CallingDb, input: { binding: CallingBinding; callerPhone: string; signal: AbortSignal }) {
  const scoped = (table: string, columns: string) => db.from(table).select(columns).eq("agency_id", input.binding.agencyId);
  const contacts = rows(await scoped("leads", "id,full_name,phone,stage,preferred_language,conversational_style,package_interest,pax,do_not_contact,updated_at")
    .ilike("phone", `%${phone(input.callerPhone).slice(-9)}`).limit(3).abortSignal(input.signal));
  const matches = contacts.filter(lead => phone(lead.phone ?? "") === phone(input.callerPhone));
  const lead = matches.length === 1 ? matches[0] : null;
  if (!lead) return { lead: null, conversations: [], quotations: [], bookings: [], messages: [], previousCalls: [], identityConflict: matches.length > 1 };
  const results = await Promise.all([
    scoped("conversations", "id,lead_id,channel,ai_enabled,human_attention_required,last_message_at").eq("lead_id", lead.id).eq("channel", "whatsapp").order("last_message_at", { ascending: false }).limit(2).abortSignal(input.signal),
    scoped("quotations", "id,quotation_number,status,total,deposit_amount,number_of_pilgrims,customer_name,customer_phone,package_id,package_snapshot,travel_month,updated_at")
      .eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(6).abortSignal(input.signal),
    scoped("bookings", "id,status,deposit_paid,amount_myr,balance_myr,pax,quotation_id,package_id,updated_at")
      .eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(6).abortSignal(input.signal),
    scoped("whatsapp_call_sessions", "id,call_id,status,call_summary,ended_at").eq("lead_id", lead.id)
      .in("status", ["terminated", "failed"]).order("ended_at", { ascending: false }).limit(2).abortSignal(input.signal),
  ]);
  const [conversations, quotations, bookings, previousCalls] = results.map(rows) as [any[], any[], any[], any[]];
  const conversation = conversations.length === 1 ? conversations[0] : null;
  const messages = conversation ? rows(await scoped("messages", "id,sender,body,modality,delivery_status,provider_message_id,created_at")
    .eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(8).abortSignal(input.signal)) : [];
  return { lead, conversations, quotations, bookings, messages, previousCalls, identityConflict: false };
}
export type CallingRecords = Awaited<ReturnType<typeof loadCallingRecords>>;

/** Identifier retrieval does not infer intent or silently select a different linked record. */
export async function includeRequestedQuotation(db: CallingDb, records: CallingRecords, binding: CallingBinding, transcript: string, signal: AbortSignal) {
  const references = Array.from(new Set(transcript.match(/\bQ-[A-Z0-9]+-[A-Z0-9]+\b/gi)?.map(ref => ref.toUpperCase()) ?? []));
  if (!records.lead || references.length !== 1 || records.quotations.some(q => String(q.quotation_number).toUpperCase() === references[0])) return records;
  const quotation = rows(await db.from("quotations").select("id,quotation_number,status,total,deposit_amount,number_of_pilgrims,customer_name,customer_phone,package_id,package_snapshot,travel_month,updated_at")
    .eq("agency_id", binding.agencyId).eq("lead_id", records.lead.id).eq("quotation_number", references[0]).limit(1).abortSignal(signal));
  if (!quotation.length) return records;
  const linked = rows(await db.from("bookings").select("id,status,deposit_paid,amount_myr,balance_myr,pax,quotation_id,package_id,updated_at")
    .eq("agency_id", binding.agencyId).eq("lead_id", records.lead.id).eq("quotation_id", quotation[0].id).limit(2).abortSignal(signal));
  return { ...records, quotations: [...quotation, ...records.quotations].slice(0, 6),
    bookings: [...linked, ...records.bookings.filter(b => !linked.some(x => x.id === b.id))].slice(0, 6) };
}

export function buildCognitivePacket(input: { binding: CallingBinding; sequence: number; snapshot: BridgeSnapshot;
  caller: CallerTurn; records: CallingRecords; language: string; now?: string }): CognitivePacket {
  const { binding, snapshot: s, records: r, caller } = input;
  const now = input.now ?? new Date().toISOString();
  const evidence: Evidence[] = [];
  const uncertainties: CognitivePacket["uncertainties"] = [];
  const add = (id: string, value: unknown, table: string, recordId: string, field: string, authority: Evidence["authority"],
    verification: Evidence["verification"], recordedAt: string | null, kind: Evidence["source"]["kind"] = "record") => {
    evidence.push({ id, value, source: { kind, table, record_id: recordId, field }, authority, verification,
      observed_at: now, recorded_at: recordedAt, conflicts: [] }); return id;
  };
  const record = (table: string, row: any, fields: string[], authority: Evidence["authority"] = "business_record") => fields.map(field =>
    add(`${table}:${row.id}:${field}`, row[field] ?? null, table, row.id, field, authority, row[field] == null ? "unknown" : "verified", row.updated_at ?? null));
  const callerRefs = [...s.callers].sort((a,b) => a.sequence-b.sequence).slice(-10).map(turn => add(`caller:${turn.id}`,
    { text: turn.transcript.slice(0, 1200), sequence: turn.sequence, confidence: turn.confidence }, "calling_caller_turns", turn.id, "transcript",
    "caller_statement", "stated", turn.persisted_at, "caller"));
  if (!callerRefs.includes(`caller:${caller.id}`)) callerRefs.push(add(`caller:${caller.id}`, { text: caller.transcript, sequence: caller.sequence, confidence: caller.confidence },
    "calling_caller_turns", caller.id, "transcript", "caller_statement", "stated", caller.persisted_at, "caller"));
  const delivered = s.events.filter(e => e.kind === "playback_complete").sort((a,b) => a.sequence-b.sequence).slice(-6);
  const deliveredRefs = delivered.map(event => add(`playback:${event.id}`, { text: String(event.payload.text ?? "").slice(0, 800), sequence: event.sequence,
    closing_question: event.payload.closing_question === true }, "calling_bridge_events", event.id, "playback_complete", "delivered_speech", "verified", event.created_at, "playback"));
  const identityRefs = r.lead ? record("leads", r.lead, ["full_name"], "verified_identity") : [];
  const address = resolveAddress(r.lead?.full_name);
  const honorificRef = r.lead && address.honorific ? add(`leads:${r.lead.id}:stored_honorific`, address.honorific, "leads", r.lead.id,
    "full_name", "verified_identity", "verified", r.lead.updated_at ?? null) : null;
  if (r.identityConflict) uncertainties.push({ id: "identity_conflict", kind: "conflict", detail: "More than one contact matches this caller; do not select one.", evidence_refs: [], blocking: true });
  if (!r.lead) uncertainties.push({ id: "identity_unknown", kind: "missing_identity", detail: "Stored caller identity is unverified.", evidence_refs: [], blocking: true });
  const selectionText = /\bQ-[A-Z0-9]+-[A-Z0-9]+\b/i.test(caller.transcript) ? caller.transcript : s.memory.objective?.text ?? caller.transcript;
  const refs = Array.from(new Set(selectionText.match(/\bQ-[A-Z0-9]+-[A-Z0-9]+\b/gi)?.map(x => x.toUpperCase()) ?? []));
  const requested = refs.length === 1 ? r.quotations.find(q => String(q.quotation_number).toUpperCase() === refs[0]) : null;
  const quote = refs.length ? requested : r.quotations.length === 1 ? r.quotations[0] : null;
  const linkedBookings = quote ? r.bookings.filter(b => b.quotation_id === quote.id) : r.bookings;
  const booking = linkedBookings.length === 1 && (quote || r.bookings.length === 1) ? linkedBookings[0] : null;
  const selectedQuote = quote ?? (booking ? r.quotations.find(q => q.id === booking.quotation_id) : null);
  if ((r.bookings.length > 1 && !booking) || (r.quotations.length > 1 && !selectedQuote) || (refs.length && !requested)) {
    uncertainties.push({ id: "record_selection", kind: "conflict", detail: "Which linked booking/quotation is being discussed is unresolved. Ask; never substitute the newest record.", evidence_refs: [], blocking: true });
  }
  const bookingRows = booking ? [booking] : r.bookings.slice(0, 2);
  const quotationRows = selectedQuote ? [selectedQuote] : r.quotations.slice(0, 2);
  const bookingRefs = bookingRows.flatMap(b => record("bookings", b, ["status", "deposit_paid", "amount_myr", "balance_myr", "pax", "quotation_id", "package_id"]));
  const quotationRefs = quotationRows.flatMap(q => record("quotations", q, ["quotation_number", "status", "total", "deposit_amount", "number_of_pilgrims", "customer_name", "travel_month"]));
  if (booking?.deposit_paid === true && selectedQuote && ["pending", "deposit_pending"].includes(selectedQuote.status)) {
    const quoteState = evidence.find(e => e.id === `quotations:${selectedQuote.id}:status`)!;
    quoteState.verification = "conflicted"; quoteState.conflicts = [`bookings:${booking.id}:deposit_paid`];
    uncertainties.push({ id: "payment_conflict", kind: "conflict", detail: "Booking deposit_paid is authoritative for payment; quotation status is stale/conflicting.", evidence_refs: quoteState.conflicts, blocking: false });
  }
  const packageRefs = quotationRows.filter(q => q.package_snapshot && typeof q.package_snapshot.name === "string").map(q =>
    add(`quotations:${q.id}:package_name`, String(q.package_snapshot.name).slice(0,200), "quotations", q.id, "package_snapshot.name",
      "business_record", "verified", q.updated_at ?? null));
  const relationshipRefs = r.lead ? record("leads", r.lead, ["stage", "package_interest", "pax"]) : [];
  const crossRefs = r.messages.slice(0, 6).filter(m => m.sender === "customer" || m.modality === "call_summary"
    || ["sent", "delivered", "read"].includes(m.delivery_status)).map(m => add(`messages:${m.id}`, { text: String(m.body ?? "").slice(0, 320),
      modality: m.modality, sender: m.sender }, "messages", m.id, "body", m.sender === "customer" ? "caller_statement" : "historical_claim",
      m.sender === "customer" ? "stated" : "unverified", m.created_at ?? null, "message"));
  for (const prior of r.previousCalls.slice(0, 2)) if (prior.call_id !== binding.callId && prior.call_summary) {
    crossRefs.push(add(`prior_call:${prior.id}`, String(prior.call_summary).slice(0, 320), "whatsapp_call_sessions", prior.id, "call_summary",
      "historical_claim", "unverified", prior.ended_at ?? null, "message"));
  }
  const actionRefs = (s.actions ?? []).filter(a => a.state === "verified_success").slice(0,4).map(a => add(`receipt:${a.id}`, a.receipt,
    "calling_bridge_actions", a.id, "receipt", "verified_execution", "verified", a.completed_at, "action_receipt"));
  for (const action of (s.actions ?? []).filter(a => ["claimed", "dispatching", "outcome_unknown"].includes(a.state))) {
    uncertainties.push({ id: `action:${action.id}`, kind: "unknown_action_outcome", detail: "A previous quotation dispatch is unverified. Do not resend or claim completion.", evidence_refs: [], blocking: requestsQuotationSend(caller.transcript) });
  }
  const resultRefs = s.events.filter(e => e.kind === "action_verified").slice(-4).map(e => add(`receipt:${e.id}`, e.payload,
    "calling_bridge_events", e.id, "receipt", "verified_execution", "verified", e.created_at, "action_receipt"));
  const conversation = r.conversations.length === 1 ? r.conversations[0] : null;
  const eligible = r.lead?.do_not_contact === false && conversation?.ai_enabled === true && !conversation.human_attention_required
    && selectedQuote && ["ready", "sent", "viewed", "discussing", "accepted", "deposit_pending", "deposit_paid", "paid", "booked"].includes(selectedQuote.status)
    && !uncertainties.some(u => u.blocking) && requestsQuotationSend(caller.transcript);
  const missing: number[] = [];
  const sequences = s.callers.map(t => t.sequence);
  for (let i = Math.max(2, input.sequence - 10); i < input.sequence; i++) if (!sequences.includes(i)) missing.push(i);
  if (caller.confidence === "unknown") uncertainties.push({ id: "asr_confidence_unknown", kind: "asr", detail: "ASR did not supply confidence. Resolve ambiguous fragments before entity changes/actions.", evidence_refs: [`caller:${caller.id}`], blocking: false });
  const memoryRef = (item: StoredMemory, field: string, index: number) => add(`memory:${field}:${index}`,
    { text: item.text, source_refs: item.source_refs }, "calling_caller_turns", item.source_refs[0]?.replace(/^caller:/, "") ?? "unknown", field,
    "caller_statement", "stated", item.observed_at ?? null, "caller");
  const objectiveRef = s.memory.objective ? memoryRef(s.memory.objective, "objective", 0) : null;
  const questionRefs = (s.memory.open_questions ?? []).slice(-4).map((item, i) => memoryRef(item, "question", i));
  const correctionRefs = (s.memory.corrections ?? []).slice(-6).map((item, i) => memoryRef(item, "correction", i));
  const packet: CognitivePacket = { version: BRIDGE_VERSION, packet_id: crypto.randomUUID(), built_at: now,
    identity: { ...binding, sequence: input.sequence, caller_turn_id: caller.id, input_revision: s.revision, generation: s.generation }, evidence,
    person: { identity_refs: identityRefs, honorific_ref: honorificRef, language: input.language, register: r.lead?.conversational_style ?? "warm conversational BM/Manglish", relationship_refs: relationshipRefs },
    business: { booking_refs: bookingRefs, quotation_refs: quotationRefs,
      traveller_refs: [...bookingRefs, ...quotationRefs].filter(id => /:(?:pax|number_of_pilgrims|customer_name)$/.test(id)),
      package_refs: [...packageRefs, ...bookingRefs, ...relationshipRefs].filter(id => /:package_/.test(id)),
      selected_booking: booking?.id ?? null, selected_quotation: selectedQuote?.id ?? null, state_complete: true },
    current_call: { current_caller: caller, caller_refs: callerRefs, delivered_assistant_refs: deliveredRefs,
      objective: s.memory.objective?.text ?? null, objective_ref: objectiveRef, open_question_refs: questionRefs, correction_refs: correctionRefs, open_questions: (s.memory.open_questions ?? []).map(q => q.text).slice(-4),
      corrections: (s.memory.corrections ?? []).map(q => q.text).slice(-6), unresolved_turns: sequences.filter(seq => !delivered.some(e => e.sequence === seq)).slice(-6), missing_sequences: missing },
    cross_channel_refs: crossRefs, open_commitment_refs: [], available_actions: eligible ? [{ tool: "deliver_existing_quotation_whatsapp",
      quotation_id: selectedQuote.id, lead_id: r.lead.id, conversation_id: conversation.id, recipient: "verified_caller_whatsapp", evidence_refs: quotationRefs }] : [],
    action_result_refs: [...actionRefs,...resultRefs], uncertainties,
    closing: { state: s.closing_state, episode_id: s.closing_episode, clarification_count: s.closing_clarifications, farewell_id: s.farewell_id }, renagi: null };
  // Do not truncate the current request or silently remove authoritative evidence to fit a prompt.
  while (JSON.stringify(packet).length > 28_000 && packet.cross_channel_refs.length) {
    const id = packet.cross_channel_refs.pop(); packet.evidence = packet.evidence.filter(e => e.id !== id);
  }
  while (JSON.stringify(packet).length > 28_000 && packet.current_call.caller_refs.length > 1) {
    const id = packet.current_call.caller_refs.find(ref => ref !== `caller:${caller.id}`);
    packet.current_call.caller_refs = packet.current_call.caller_refs.filter(ref => ref !== id);
    packet.evidence = packet.evidence.filter(e => e.id !== id);
  }
  if (JSON.stringify(packet).length > 28_000) throw new Error("calling_packet_budget_exceeded");
  return packet;
}
