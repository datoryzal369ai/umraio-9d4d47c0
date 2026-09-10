/** Calling-only conversation safeguards. No media, provider or shared text changes. */
import type { CallerAddress } from "./cognitive-router.core";
import { detectTravellerCount, type VoiceTranscriptTurn, type VoiceTurnMediaMetrics } from "./voice-turn.core";

export function reconcilePlayback(history: VoiceTranscriptTurn[], metrics: VoiceTurnMediaMetrics | undefined, sequence: number): VoiceTranscriptTurn[] {
  const previous = metrics?.prev_sequence;
  const complete = metrics?.playback_complete_ms;
  if (!Number.isInteger(previous) || !previous || previous >= sequence || !Number.isFinite(complete) || !complete || complete <= 0 || complete > 600_000) return history;
  return history.map(turn => turn.role === "umraio" && turn.sequence === previous && turn.delivery === "generated"
    ? { ...turn, delivery: "playback_complete" } : turn);
}

export function deliveredHistory(history: VoiceTranscriptTurn[]): VoiceTranscriptTurn[] {
  return history.filter(turn => turn.role === "customer" || turn.delivery === "playback_complete");
}

/** Three cache-compatible phrases. None claims a lookup or an external action. */
export function acknowledgementOptions(address: CallerAddress, language: string): string[] {
  const title = address.honorific ? ` ${address.honorific}` : "";
  return language.startsWith("en")
    ? [`Understood${title}.`, `Okay${title}.`, `I hear you${title}.`]
    : [`Baik${title}.`, `Faham${title}.`, `Oh begitu${title}.`];
}

export function contextualAcknowledgement(args: { address: CallerAddress; language: string; transcript: string; previous?: string }): string {
  const options = acknowledgementOptions(args.address, args.language);
  // Reflect the current activity: request, explanation/correction, or concern.
  let index = /\b(risau|bimbang|susah|kecewa|worried|concern)\b/i.test(args.transcript) ? 2
    : /\b(sebenarnya|maksud|bukan|tadi|because|actually|sudah|dah)\b/i.test(args.transcript) ? 1 : 0;
  if (options[index] === args.previous) index = (index + 1) % options.length;
  return options[index]!;
}

const UNCERTAIN = /^(?:ja|skjab|skjap|ede|[a-z]{1,2})(?:[\s,.!?]+(?:skjab|skjap|ja))*[\s,.!?]*$/i;
const CONFIRM = /^(?:ya|yes|betul|betul tu|sah|confirm|correct|ya betul)[\s,.!?]*$/i;
export type EntityDecision = { reply: string | null; proposal?: string; confirmed?: string; travellers?: number; uncertain?: boolean };

/** No entity mutation from a fragment or a question that was never played. */
export function entityDecision(text: string, history: VoiceTranscriptTurn[], language: string): EntityDecision {
  const en = language.startsWith("en");
  const last = history.at(-1);
  if (CONFIRM.test(text) && last?.role === "umraio" && last.entityProposal) {
    if (last.delivery !== "playback_complete") return {
      reply: en ? `Please confirm: ${last.entityProposal}?` : `Boleh sahkan: ${last.entityProposal}?`, proposal: last.entityProposal,
    };
    const travellers = detectTravellerCount(last.entityProposal);
    return { reply: en ? "Understood. I have noted your correction; the booking record has not been changed." : "Baik, saya catat pembetulan itu. Rekod tempahan belum diubah.",
      confirmed: last.entityProposal, ...(travellers ? { travellers } : {}) };
  }
  if (UNCERTAIN.test(text.trim()) && !/^(ya|hi|ok)[.!?\s]*$/i.test(text)) {
    return { reply: en ? "I didn't catch that. Could you repeat it?" : "Saya kurang jelas tadi. Boleh ulang sikit?", uncertain: true };
  }
  const proposesName = /\b(?:nama (?:saya|jemaah|travell?er|pelanggan)|(?:tukar|betulkan|ubah) nama|my name is)\b/i.test(text);
  const travellers = detectTravellerCount(text);
  const proposesCount = travellers && !/\?|\b(?:berapa|kalau|jika|untuk harga|how much|what if)\b/i.test(text);
  if ((proposesName || proposesCount) && !/\?|\b(?:jangan|bukan|don't|do not)\b/i.test(text)) {
    const proposal = text.replace(/\s+/g, " ").trim().slice(0, 180);
    return { reply: en ? `Before I note an identity change, please confirm: ${proposal}?` : `Sebelum saya catat perubahan maklumat, boleh sahkan: ${proposal}?`, proposal };
  }
  return { reply: null };
}

/** Bounded durable notes beyond the short dialogue window, always source-labelled. */
export function structuredCallNotes(history: VoiceTranscriptTurn[]): string[] {
  const notes = history.filter(t => t.role === "customer" && !t.uncertainAsr && (t.confirmedEntity || /\b(?:betulkan|pembetulan|bukan|sebenarnya|janji|komitmen|hantar|send|correction|commitment)\b/i.test(t.text)))
    .slice(-6).map(t => t.confirmedEntity ? `Caller-confirmed correction (not a booking mutation): ${t.confirmedEntity}`
      : `Caller statement/request, not verified execution: ${t.text.slice(0, 180)}`);
  const receipts = history.filter(t => t.actionReceipt).slice(-3).map(t => `Verified WhatsApp dispatch: quotation ${t.actionReceipt!.quotationId}; message ${t.actionReceipt!.messageId}.`);
  return [...notes, ...receipts];
}

export function requestsQuotationSend(text: string): boolean {
  if (/\b(?:jangan|tak payah|tak usah|belum perlu|don't|do not|no need|nanti|selepas|lepas call|after|tomorrow|esok)\b/i.test(text)) return false;
  if (/\b(?:dia|mereka|isteri|suami|kawan|pelanggan lain|him|her|them)\b|\+?\d[\d\s-]{7,}/i.test(text)) return false;
  if (/\b(?:e-?mail|telegram|nombor (?:lain|baru)|another number|new number)\b/i.test(text)) return false;
  if (/\b(?:kalau|jika|contoh(?:nya)?|misalnya|maksud|what if|for example|how do)\b/i.test(text)) return false;
  if (/\b(?:saya|kami|I|we)\s+(?:(?:akan|boleh|dah|sudah|will|can|have)\s+)?(?:hantar|kirim|send|sent)\b/i.test(text)) return false;
  const asks = /\b(?:hantar(?:kan)?|kirim(?:kan)?|send|forward)\b/i.test(text);
  const quote = /\b(?:quotation|sebut\s*harga|quote)\b/i.test(text);
  const report = /\b(?:dah|sudah|telah|already|did you|have you)\b.{0,30}\b(?:hantar|send|sent)\b/i.test(text);
  return asks && quote && !report;
}

/** Reasoning has no tools. Only the deterministic, receipt-bearing action branch may report execution. */
export function preventUnverifiedActionClaim(text: string, language: string): string {
  const claim = /\b(?:(?:saya|kami|I|we)\s+(?:(?:akan|dah|sudah|telah|boleh|will|have|can|'ll)\s+){0,2}(?:hantar\w*|kirim\w*|uruskan|buat\w*|tempahkan|send\w*|sent|book\w*|done|arrange\w*)|(?:akan|dah|sudah|telah)\s+di(?:hantar|buat|uruskan)|(?:I|we)['’](?:ll|ve)\s+(?:send|sent|done|arrange|book)|(?:has|have|was|is)\s+(?:been\s+)?(?:sent|booked|done))\b/i;
  const indirect = /\b(?:saya|kami|I|we)\s+(?:akan|dah|sudah|telah|will|have)\b[^.!?]{0,90}\b(?:hantar\w*|dihantar|kirim\w*|uruskan|buat|send|sent|done|booked)\b/i;
  const passive = /\b(?:quotation|sebut harga|mesej|message|booking|tempahan)\b[^.!?]{0,30}\b(?:akan|dah|sudah|telah|will be)\s+(?:sampai|dihantar|selesai|sent|done|arranged)\b/i;
  return claim.test(text) || indirect.test(text) || passive.test(text)
    ? language.startsWith("en") ? "I can't confirm that action has been completed. No verified execution result is available." : "Saya belum boleh sahkan tindakan itu selesai. Belum ada pengesahan pelaksanaan."
    : text;
}

/** A stale model assumption cannot override an actual paid-deposit record. */
export function protectBookingAuthority(text: string, facts: Record<string, unknown>, language: string): string {
  const booking = facts["booking"] as { deposit_paid?: boolean; status?: string } | null | undefined;
  if (booking?.deposit_paid !== true || ["cancelled", "refunded"].includes(booking.status ?? "")) return text;
  const contradicts = /\b(?:booking|tempahan|deposit)\b[^.!?]{0,60}\b(?:pending|belum (?:dibayar|bayar)|menunggu (?:deposit|bayaran)|unpaid|not paid|awaiting payment)\b/i.test(text);
  return contradicts ? language.startsWith("en") ? "The booking record shows your deposit has been paid." : "Rekod tempahan menunjukkan deposit sudah dibayar." : text;
}
