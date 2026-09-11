import { BRIDGE_VERSION, type CognitiveDecision, type CognitivePacket } from "./cognitive-bridge.contract";

/** A deterministic last boundary in addition to semantic claim_requests. */
export function unsupportedActionSpeech(text: string): boolean {
  // Explicit uncertainty/blocked language is not a successful or future-action claim.
  const clauses = text.split(/[.!?;\n]+/).filter(Boolean);
  return clauses.some(clause => {
    if (/\b(?:belum (?:boleh |dapat )?(?:sahkan|disahkan)|tidak dapat (?:sahkan|disahkan)|cannot confirm|can't confirm|could not be (?:completed|verified))\b/i.test(clause)) return false;
    if (/\b(?:sudah|dah|telah|has been|have been|was)\s+(?:dibaca|read)\b/i.test(clause)) return true;
    const action = /\b(?:hantar\w*|dihantar|menghantar|urus\w*|diurus\w*|mengurus\w*|send|sent|deliver\w*|arrange\w*|process\w*|lakukan|dilakukan|buat|dibuat|selesaikan|diselesaikan)\b/i;
    return action.test(clause) && /\b(?:akan|nanti|sudah|dah|telah|sedang|bakal|will|shall|have|has|done|sent|dihantar|diuruskan|diselesaikan)\b|\b(?:saya|kami|kita|pihak|agensi|I|we|agency)\b[^.!?]{0,45}\b(?:hantar|uruskan|send|arrange)\b/i.test(clause);
  });
}

export function claimsSupported(decision: CognitiveDecision, packet: CognitivePacket): boolean {
  const facts = new Map(packet.evidence.map(item => [item.id, item]));
  for (const claim of decision.claim_requests) {
    const evidence = facts.get(claim.source_ref);
    if (!evidence || !decision.spoken_response.includes(claim.spoken_span) || evidence.verification !== "verified") return false;
    if (claim.kind === "execution_read") return false; // v1 has provider send receipts, never reader proof.
    if (claim.kind === "execution_sent" && evidence.authority !== "verified_execution") return false;
    if (claim.kind === "commitment") return false; // No deferred job creation is available in v1.
    if (claim.kind === "business_status" && evidence.authority !== "business_record") return false;
    if (claim.kind === "identity" && evidence.authority !== "verified_identity") return false;
  }
  if (unsupportedActionSpeech(decision.spoken_response)) {
    // Past sent status may be restated only with an exact verified receipt-backed span.
    const clauses = decision.spoken_response.split(/[.!?;\n]+/).filter(unsupportedActionSpeech);
    for (const clause of clauses) {
      if (/\b(?:akan|nanti|bakal|will|shall)\b/i.test(clause)) return false;
      const backed = decision.claim_requests.some(claim => claim.kind === "execution_sent"
        && claim.spoken_span.includes(clause.trim()) && facts.get(claim.source_ref)?.authority === "verified_execution");
      if (!backed) return false;
    }
  }
  return true;
}

export function callingRecovery(language: string, reason: "ambiguity" | "unavailable" = "ambiguity"): string {
  if (language.startsWith("en")) return reason === "unavailable" ? "Sorry, I cannot verify that information right now." : "Sorry, I cannot give a reliable answer to that yet.";
  return reason === "unavailable" ? "Maaf, maklumat itu belum dapat saya pastikan sekarang." : "Maaf, jawapan itu belum dapat saya pastikan.";
}

/** A fresh non-action response from packet evidence, never salvaged unvalidated model speech. */
export function callingContractRecovery(packet: CognitivePacket): CognitiveDecision {
  const en = packet.person.language.startsWith("en");
  const dialogue = packet.dialogue;
  const missing = dialogue?.missing;
  const identity = packet.evidence.find(e => e.id === "runtime:identity_continuation" && e.authority === "runtime"
    && e.verification === "verified")?.value as { name_received?: boolean; next_step?: string } | undefined;
  const ask = missing && !missing.offered && !missing.response_received ? missing : null;
  const current = packet.current_call.current_caller.transcript;
  const social = /\b(?:apa khabar|sihat|how are you)\b/i.test(current);
  const apology = dialogue?.correction ? (en ? "Sorry, I misunderstood earlier. " : "Maaf, saya tersalah faham tadi. ") : "";
  const used = [...(dialogue?.source_refs ?? [])];
  const claims: CognitiveDecision["claim_requests"] = [];
  let spoken = callingRecovery(packet.person.language);
  if (ask) spoken = apology + (ask.fact === "caller_identity" && identity?.name_received
    ? (en ? "Thank you, I have your stated name. To continue verification, " : "Terima kasih, nama sudah saya terima. Untuk teruskan pengesahan, ")
    : dialogue?.topic === "booking" && ask.fact !== "completion" ? (en ? "About the booking status. " : "Tentang status tempahan tadi. ") : "") + ask.question;
  else if (social) spoken = en ? "I am ready to help, thank you for asking." : "Saya sedia membantu, terima kasih kerana bertanya.";
  else if (dialogue?.topic === "booking") {
    spoken = apology + (en ? "The earlier question was about the booking status. " : "Soalan tadi tentang status tempahan. ");
    spoken += missing?.fact === "caller_identity"
      ? (en ? "The booking holder's identity is still unverified, so I cannot share private booking details."
        : "Identiti pemilik tempahan masih belum dapat disahkan, jadi butiran peribadi belum boleh saya kongsikan.")
      : (en ? "I cannot confirm its status from the available records yet." : "Statusnya belum dapat saya pastikan daripada rekod yang tersedia.");
    if (missing?.fact === "caller_identity" && identity?.name_received) spoken += en
      ? " The agency needs to verify the booking holder and linked WhatsApp number through its official contact channel; a name or quotation reference alone is insufficient."
      : " Pengesahan pemilik tempahan dan nombor WhatsApp perlu dibuat dengan agensi melalui saluran rasmi; nama atau rujukan sahaja belum mencukupi.";
    if (packet.person.identity_refs.length && !missing) {
      const paid = packet.evidence.find(e => e.id === `bookings:${packet.business.selected_booking}:deposit_paid`
        && e.value === true && e.verification === "verified" && e.authority === "business_record");
      const status = packet.evidence.find(e => e.id === `bookings:${packet.business.selected_booking}:status`
        && e.verification === "verified" && e.authority === "business_record");
      const statusText: Record<string, [string,string]> = {
        confirmed: ["Rekod menunjukkan tempahan disahkan.", "The record shows the booking is confirmed."],
        booked: ["Rekod menunjukkan tempahan disahkan.", "The record shows the booking is confirmed."],
        cancelled: ["Rekod menunjukkan tempahan dibatalkan.", "The record shows the booking is cancelled."],
        refunded: ["Status dalam rekod ialah refunded.", "The recorded status is refunded."],
      };
      const span = paid && !["cancelled", "refunded"].includes(String(status?.value))
        ? (en ? "The booking record shows the deposit has been paid." : "Rekod tempahan menunjukkan deposit sudah dibayar.")
        : statusText[String(status?.value)]?.[en ? 1 : 0];
      const fact = paid && !["cancelled", "refunded"].includes(String(status?.value)) ? paid : status;
      if (span && fact) { spoken = apology + span; used.push(fact.id); claims.push({kind:"business_status",source_ref:fact.id,spoken_span:span}); }
    }
  } else if (dialogue?.correction) spoken = apology + (en ? "I will not ask you to repeat the same explanation." : "Tidak perlu ulang penjelasan yang sama.");
  else if (/\b(?:assalamualaikum|salam|hello|hi)\b/i.test(current)) spoken = en ? "Hello, I am here to help." : "Salam, saya sedia membantu.";
  const quote = current.slice(0, 500);
  const memory = { text: quote, evidence_quote: quote, source_refs: [`caller:${packet.identity.caller_turn_id}`] };
  return {
    decision_version: BRIDGE_VERSION, packet_id: packet.packet_id, input_revision: packet.identity.input_revision,
    caller_turn_id: packet.identity.caller_turn_id, generation: packet.identity.generation,
    intent: ask ? "specific_clarification" : "supported_recovery", intent_confidence: 1,
    interaction_mode: ask ? "CLARIFY" : social ? "SOCIAL" : "ANSWER",
    understanding: "Respond using retained caller context without asserting an unverified business outcome.",
    authoritative_facts_used: used, uncertainties: [],
    requires_clarification: !!ask, clarification: ask ? { fact: ask.fact, key: ask.key } : null,
    response_strategy: ask ? "Ask one missing critical fact." : "Acknowledge retained context and state the exact limit without a repeated question.",
    action_required: false, requested_action: null, allowed_tool: null, requires_confirmation: false,
    completion_intent: ask?.fact === "completion" ? "possible" : "none", next_state: ask?.fact === "completion" ? "possible_completion" : "active", spoken_response: spoken, claim_requests: claims,
    memory_update: { objective: !packet.current_call.objective && dialogue?.topic === "booking"
      && /\b(?:status|tempahan|booking)\b/i.test(current) ? memory : null,
      corrections: dialogue?.correction ? [memory] : [], open_questions: [] },
    decision_summary: ask ? "A specific missing fact requires clarification; identity remains unverified." : "Internal failure was not converted into caller ambiguity.",
  };
}
