/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CallingBinding, CallingDb, CallerTurn } from "./caller-turn-ledger.server";
import { BRIDGE_VERSION, type CognitivePacket, type Evidence, type ClosingState, type CallingDialogue, type ClarificationOffer, type ClarificationFact } from "./cognitive-bridge.contract";
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
export async function loadCallingRecords(db: CallingDb, input: { binding: CallingBinding; callerPhone: string; signal: AbortSignal }): Promise<CallingRecords> {
  const scoped = (table: string, columns: string) => db.from(table).select(columns).eq("agency_id", input.binding.agencyId);
  const contacts = rows(await scoped("leads", "id,full_name,phone,stage,preferred_language,conversational_style,package_interest,pax,do_not_contact,updated_at")
    .ilike("phone", `%${phone(input.callerPhone).slice(-9)}`).limit(3).abortSignal(input.signal));
  const matches = contacts.filter(lead => phone(lead.phone ?? "") === phone(input.callerPhone));
  const lead = matches.length === 1 ? matches[0] : null;
  if (!lead) return { lead: null, conversations: [], quotations: [], bookings: [], messages: [], previousCalls: [], identityConflict: matches.length > 1,
    identityKey: matches.map(m => String(m.id)).sort().join("|") || "unmatched", identityCandidates: matches,
    recognition: await loadCallingRecognition(db, input, matches) };
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
export type CallingRecords = { lead: any; conversations: any[]; quotations: any[]; bookings: any[]; messages: any[];
  previousCalls: any[]; identityConflict: boolean; identityKey?: string; identityCandidates?: any[];
  identityContinuation?: IdentityContinuation; nameEvidence?: { text: string; caller: CallerTurn };
  recognition?: CallingRecognition | null };

type CallingRecognition = { conversation_id: string; observed_at: string | null; language: string | null;
  caller_name: { text: string; message_id: string; recorded_at: string | null } | null;
  intent: "booking" | "umrah" | null };

/** Only an exact, tenant-bound WhatsApp thread may supply recognition before record authorization.
 * Never return raw messages, contact IDs, bookings, quotations, payments or arbitrary conversation summaries.
 * Absence, ambiguity and lookup failure leave recognition unknown; they cannot authorize a contact.
 */
async function loadCallingRecognition(db: CallingDb, input: { binding: CallingBinding; callerPhone: string; signal: AbortSignal }, candidates: any[]): Promise<CallingRecognition | null> {
  if (!candidates.length) return null;
  try {
    const normalized = phone(input.callerPhone);
    const threads = rows(await db.from("conversations").select("id,lead_id,external_id,last_message_at")
      .eq("agency_id", input.binding.agencyId).eq("channel", "whatsapp")
      .in("external_id", [normalized, `+${normalized}`]).limit(2).abortSignal(input.signal));
    if (threads.length !== 1 || !threads[0].last_message_at) return null;
    const thread = threads[0];
    const candidate = candidates.find(c => c.id === thread.lead_id);
    if (!candidate || phone(thread.external_id) !== normalized) return null;
    const messages = rows(await db.from("messages").select("id,body,created_at")
      .eq("agency_id", input.binding.agencyId).eq("conversation_id", thread.id).eq("sender", "customer")
      .order("created_at", { ascending: false }).limit(8).abortSignal(input.signal));
    if (!messages.length) return null;
    const named = messages.map(m => ({ message: m, name: extractCallingName(String(m.body ?? "").slice(0, 1200), false) }))
      .find(m => m.name && identityName(m.name) === identityName(String(candidate.full_name ?? "")));
    return { conversation_id: thread.id, observed_at: thread.last_message_at,
      language: ["ms", "ms-MY", "en", "en-MY"].includes(candidate.preferred_language) ? candidate.preferred_language : null,
      caller_name: named?.name ? { text: named.name, message_id: named.message.id, recorded_at: named.message.created_at ?? null } : null,
      intent: messages.some(m => bookingTopic.test(String(m.body ?? "").slice(0, 1200))) ? "booking"
        : messages.some(m => /\bumrah\b/i.test(String(m.body ?? "").slice(0, 1200))) ? "umrah" : null };
  } catch { input.signal.throwIfAborted(); return null; }
}

type IdentityContinuation = { candidate_key: string; name_source_ref: string; narrowed_ids: string[];
  reference_source_ref: string | null; step: "reference" | "agency" };
const identityName = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ms")
  .replace(/^(?:nama saya|my name is|saya(?: ni| ini)?)\s+/u, "")
  .replace(/^(?:(?:datuk|dato['’]?|encik|puan|tuan|haji|hajah)\s+)+/u, "")
  .replace(/[.!?]+$/u, "").replace(/\s+/gu, " ").trim();

/** Extract only a caller-stated name span; the rest of the utterance remains authoritative intent evidence. */
function extractCallingName(text: string, standalone: boolean): string | null {
  const explicit = /\b(?:nama saya|my name is)\s+([^,;:.!?\n]+)|\bsaya(?: ni| ini)?\s+((?:datuk|dato['’]?|encik|puan|tuan|haji|hajah)\s+[^,;:.!?\n]+)/iu.exec(text);
  const span = (explicit?.[1] ?? explicit?.[2] ?? (standalone ? text : ""))
    .split(/\s+(?:saya|nak|ingin|mahu|hendak|dan|and|want|would)\b/iu)[0]!.replace(/[.!?]+$/u, "").trim();
  if (!span || span.length > 80 || span.split(/\s+/u).length > 6 || !/^[\p{L}\p{M}'’ -]+$/u.test(span)
    || /\b(?:bukan|not|tempahan|tembahan|booking|quotation|tanya|faham|rekod|cek)\b/iu.test(span)) return null;
  return text.includes(span) ? span : null;
}

/** Narrow routing candidates only. Names and guessable Q references NEVER grant record access.
 * The unchanged, tenant-scoped unique-phone resolver above remains the verification authority.
 * Persist only source references/IDs in server-owned proposal metadata, not another copy of names.
 */
export async function continueCallingIdentity(db: CallingDb, records: CallingRecords, binding: CallingBinding,
  state: BridgeSnapshot, caller: CallerTurn, signal: AbortSignal): Promise<CallingRecords> {
  if (records.lead) return records;
  const candidates = records.identityCandidates ?? [];
  const key = records.identityKey ?? "unmatched";
  const previous = [...state.events].filter(e => e.kind === "proposal" && e.sequence < caller.sequence)
    .sort((a,b) => b.sequence-a.sequence)[0]?.payload.identity_continuation as IdentityContinuation | undefined;
  const retained = previous?.candidate_key === key && typeof previous.name_source_ref === "string"
    && previous.name_source_ref.startsWith("caller:") && Array.isArray(previous.narrowed_ids) ? previous : undefined;
  const nameOffer = priorClarificationOffers(state, caller.sequence).find(o => o.fact === "caller_identity"
    && o.key === `caller_identity:${key}`);
  const named = [...state.callers, caller].sort((a,b) => b.sequence-a.sequence).map(t => ({ caller: t,
    text: extractCallingName(t.transcript, candidates.some(c => identityName(String(c.full_name ?? "")) === identityName(t.transcript))
      || !!nameOffer && t.sequence === nameOffer.sequence + 1) })).find(t => t.text);
  const nameTurn = named?.caller;
  if (!nameTurn && !retained) return records;
  const sameName = !nameTurn || `caller:${nameTurn.id}` === retained?.name_source_ref;
  const narrowed = retained && sameName ? candidates.filter(c => retained.narrowed_ids.includes(String(c.id)))
    : candidates.filter(c => identityName(String(c.full_name ?? "")) === identityName(named!.text!));
  const continuation: IdentityContinuation = { candidate_key: key,
    name_source_ref: nameTurn ? `caller:${nameTurn.id}` : retained!.name_source_ref,
    narrowed_ids: narrowed.map(c => String(c.id)), reference_source_ref: sameName ? retained?.reference_source_ref ?? null : null, step: "agency" };
  if (narrowed.length && !continuation.reference_source_ref) {
    // Only determine whether the existing reference path is available. Do not put candidate records in the packet.
    const referenceTurn = [...state.callers, caller].sort((a,b) => b.sequence-a.sequence)
      .find(t => /\bQ-[A-Z0-9]+-[A-Z0-9]+\b/i.test(t.transcript));
    const refs = [...new Set(referenceTurn?.transcript.match(/\bQ-[A-Z0-9]+-[A-Z0-9]+\b/gi)?.map(s => s.toUpperCase()) ?? [])];
    const query = db.from("quotations").select("id,lead_id").eq("agency_id", binding.agencyId)
      .in("lead_id", continuation.narrowed_ids);
    let matches: any[];
    try { matches = rows(await (refs.length === 1 ? query.eq("quotation_number", refs[0]) : query).limit(3).abortSignal(signal)); }
    catch { signal.throwIfAborted(); return { ...records, identityContinuation: continuation,
      ...(named?.text ? { nameEvidence: { text: named.text, caller: named.caller } } : {}) }; }
    if (referenceTurn) {
      continuation.reference_source_ref = `caller:${referenceTurn.id}`;
      if (refs.length === 1) continuation.narrowed_ids = [...new Set(matches.map(q => String(q.lead_id)))];
    } else if (matches.length) continuation.step = "reference";
  }
  // Even one name/reference match is not independently verified identity. No lead, business data or action is released.
  return { ...records, identityContinuation: continuation, ...(named?.text ? { nameEvidence: { text: named.text, caller: named.caller } } : {}) };
}

/** Reuse the caller's most recent explicit reference; it does not establish customer identity. */
export function callingSelectionText(s: BridgeSnapshot, current: string): string {
  const hasReference = (text: string) => /\bQ-[A-Z0-9]+-[A-Z0-9]+\b/i.test(text);
  if (hasReference(current)) return current;
  return [...s.callers].sort((a,b) => b.sequence-a.sequence).find(c => hasReference(c.transcript))?.transcript
    ?? s.memory.objective?.text ?? current;
}

const bookingTopic = /\b(?:tempahan|tembahan|booking|quotation|sebut harga|deposit|status saya|my (?:booking|status))\b/i;
const socialTurn = /\b(?:apa khabar|sihat|how are you)\b/i;

export function priorClarificationOffers(s: BridgeSnapshot, sequence: number): ClarificationOffer[] {
  const previous = [...s.events].filter(e => e.kind === "proposal" && e.sequence < sequence).sort((a,b) => b.sequence-a.sequence)[0];
  return (Array.isArray(previous?.payload.clarification_offers) ? previous.payload.clarification_offers : [])
    .filter((x: any) => ["caller_identity", "booking_reference", "caller_request", "completion"].includes(x.fact)
      && typeof x.key === "string" && x.key.length <= 500 && Number.isInteger(x.sequence) && x.sequence < sequence).slice(-6);
}

/** Persisted question offers are reused, without confusing a spoken name with verified identity. */
function callingDialogue(s: BridgeSnapshot, caller: CallerTurn, records: CallingRecords, language: string,
  recordSelectionMissing: boolean): CallingDialogue {
  const en = language.startsWith("en");
  const ordered = [...s.callers].sort((a,b) => a.sequence-b.sequence);
  const current = caller.transcript;
  const objective = [...ordered].reverse().find(c => bookingTopic.test(c.transcript));
  const topic = objective || bookingTopic.test(s.memory.objective?.text ?? "") ? "booking" : "general";
  const correction = /\b(?:tadi|bukan itu|salah faham|tak faham|takfaham|tanya.*(?:banyak|ulang)|keeps? asking|already (?:said|told)|misunderst[ao]nd)\b/i.test(current);
  const offered = priorClarificationOffers(s, caller.sequence);
  let fact: ClarificationFact | null = null;
  const lastDelivered = [...s.events].filter(e => e.kind === "playback_complete").sort((a,b) => b.sequence-a.sequence)[0];
  if (/^\s*(?:ok(?:ay)?|baik|ya|yes)[.!\s]*$/i.test(current) && lastDelivered?.payload.closing_question !== true) fact = "completion";
  else if (topic === "booking" && !socialTurn.test(current)) {
    if (!records.lead) fact = "caller_identity";
    else if (recordSelectionMissing) fact = "booking_reference";
  } else if (topic === "general" && /^(?:ja|skjab|skjap|ede|[a-z]{1,2})(?:[\s,.!?]+(?:skjab|skjap|ja))*[\s,.!?]*$/i.test(current.trim())
    && !/^(?:hi|ok|ya)[.!?\s]*$/i.test(current.trim())) fact = "caller_request";
  // Ambiguous current text is not proof of an unanswered business fact. The model can answer using prior evidence.
  if (topic === "general" && /\be-?mel\b.*\bbelum boleh hantar\b/i.test(current)) fact = "caller_request";
  const identityStep = records.identityContinuation;
  const evidenceKey = fact === "caller_identity" ? `${identityStep ? "reference:" : ""}${records.identityKey ?? "unverified"}`
    : fact === "booking_reference" ? records.quotations.map(q => String(q.id)).sort().join("|")
      : fact === "completion" ? s.closing_episode ?? "active" : "request";
  const key = `${fact}:${evidenceKey}`;
  const prior = offered.find(o => o.key === key);
  const responseReceived = !!prior && ordered.some(c => c.sequence > prior.sequence)
    || fact === "caller_identity" && (identityStep ? !!identityStep.reference_source_ref || identityStep.step === "agency"
      : ordered.some(c => extractCallingName(c.transcript, false) !== null))
    || fact === "booking_reference" && ordered.some(c => /\bQ-[A-Z0-9]+-[A-Z0-9]+\b/i.test(c.transcript));
  const questions = {
    caller_identity: identityStep
      ? (en ? "What quotation reference did you receive from the agency?" : "Apakah nombor rujukan sebut harga yang diterima daripada agensi?")
      : (en ? "What full name was used for the booking?" : "Apakah nama penuh yang digunakan untuk tempahan itu?"),
    booking_reference: en ? "What is the booking or quotation reference?" : "Apakah nombor rujukan tempahan atau sebut harga yang dimaksudkan?",
    caller_request: en ? "What is the main thing you would like help with?" : "Apakah perkara utama yang ingin ditanya?",
    completion: en ? "Is that all for now?" : "Itu sahaja untuk sekarang?",
  };
  return { topic, correction, source_refs: [...new Set([...(objective ? [`caller:${objective.id}`] : []), `caller:${caller.id}`])], offered,
    missing: fact ? { fact, key, question: questions[fact], offered: !!prior || fact === "completion" && s.closing_clarifications >= 1, response_received: !!responseReceived } : null };
}

export function nextClarificationOffers(packet: CognitivePacket, decision: CognitiveDecisionLike): ClarificationOffer[] {
  const offered = packet.dialogue?.offered ?? [];
  const clarification = decision?.clarification;
  return clarification ? [...offered.filter(o => o.fact !== clarification.fact),
    { ...clarification, sequence: packet.identity.sequence }].slice(-6) : offered;
}
type CognitiveDecisionLike = { clarification?: { fact: ClarificationFact; key: string } | null | undefined } | null;

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
  if (r.identityContinuation) add("runtime:identity_continuation", { identity_verified: false,
    name_received: true, next_step: r.identityContinuation.step, reference_received: !!r.identityContinuation.reference_source_ref,
    narrowed_candidate_count: r.identityContinuation.narrowed_ids.length }, "calling_bridge_events", binding.sessionId,
    "identity_continuation", "runtime", "verified", null, "runtime");
  if (r.nameEvidence) add(`caller_name:${r.nameEvidence.caller.id}`, { text: r.nameEvidence.text, identity_verified: false },
    "calling_caller_turns", r.nameEvidence.caller.id, "transcript", "caller_statement", "stated", r.nameEvidence.caller.persisted_at, "caller");
  const selectionText = callingSelectionText(s, caller.transcript);
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
  if (r.recognition) {
    const recognition = r.recognition;
    crossRefs.push(add("runtime:whatsapp_recognition", { prior_interaction: true, identity_verified: false,
      language: recognition.language, intent: recognition.intent }, "conversations", recognition.conversation_id,
      "external_id", "runtime", "verified", recognition.observed_at, "runtime"));
    if (recognition.caller_name) crossRefs.push(add(`recognition_name:${recognition.caller_name.message_id}`,
      { text: recognition.caller_name.text, identity_verified: false }, "messages", recognition.caller_name.message_id,
      "body", "caller_statement", "stated", recognition.caller_name.recorded_at, "message"));
  }
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
  packet.dialogue = callingDialogue(s, caller, r, input.language, uncertainties.some(u => u.id === "record_selection"));
  packet.dialogue.source_refs = packet.dialogue.source_refs.filter(id => evidence.some(e => e.id === id));
  // Do not truncate the current request or silently remove authoritative evidence to fit a prompt.
  while (JSON.stringify(packet).length > 28_000 && packet.cross_channel_refs.length) {
    const id = packet.cross_channel_refs.pop(); packet.evidence = packet.evidence.filter(e => e.id !== id);
  }
  while (JSON.stringify(packet).length > 28_000 && packet.current_call.caller_refs.length > 1) {
    const id = packet.current_call.caller_refs.find(ref => ref !== `caller:${caller.id}`);
    packet.current_call.caller_refs = packet.current_call.caller_refs.filter(ref => ref !== id);
    packet.evidence = packet.evidence.filter(e => e.id !== id);
  }
  packet.dialogue.source_refs = packet.dialogue.source_refs.filter(id => packet.evidence.some(e => e.id === id));
  if (JSON.stringify(packet).length > 28_000) throw new Error("calling_packet_budget_exceeded");
  return packet;
}
