import type { CognitiveDecision, CognitivePacket } from "./cognitive-bridge.contract";

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
  if (language.startsWith("en")) return reason === "unavailable" ? "Sorry, I couldn't verify that just now. Could you clarify what you need?" : "Sorry, I want to get that right. What did you mean?";
  return reason === "unavailable" ? "Maaf, saya belum dapat pastikan perkara itu. Boleh jelaskan apa yang diperlukan?" : "Maaf, saya nak pastikan saya faham betul. Maksudnya macam mana ya?";
}
