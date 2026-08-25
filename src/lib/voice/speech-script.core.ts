/**
 * UMRAIO® VOICE — SPEECH SCRIPT LAYER (minimal, post-V4 rollback).
 *
 *   AI SALES REPLY (written)
 *      → SPEECH SCRIPT LAYER (this file)
 *      → VOICE PRESENTATION LAYER (rhythm + Malay normalisation)
 *      → OpenAI /v1/audio/speech
 *
 * SCOPE DELIBERATELY NARROW. The V4 experiment rewrote written Malay through a
 * large register dictionary ("selain itu" → "lepas tu", "merupakan" → "memang",
 * …). It made voice notes sound like artificial slang, so it was REMOVED.
 * Natural Malaysian conversational speech must come from the TTS model plus
 * concise conversational source text — not from regex.
 *
 * What remains here is only what a text-to-speech engine genuinely cannot say:
 * markdown/bullets written for the eye, and shorthand forms ("4 pax", "&",
 * "5D/4M") that would otherwise be read out literally.
 *
 * HARD RULE — FACTS ARE NEVER TOUCHED: prices, dates, hotel names, package
 * names, durations and religious content pass through unchanged.
 */

/** Honorifics a Malaysian consultant uses — spoken at most ONCE per note. */
const HONORIFICS = /\b(Datuk|Dato'|Datin|Tuan|Puan|Encik|Cik)\b/g;

/** Shorthand written for the eye, not the ear. No register rewriting here. */
const EYE_ONLY_FORMS: Array<[RegExp, string]> = [
  [/\bRM\s+(?=\d)/g, "RM"],
  [/(\d)\s*(?:pax|PAX|Pax)\b/g, "$1 orang"],
  [/\b(\d+)\s*[dD]\/?\s*(\d+)\s*[mM]\b/g, "$1 hari $2 malam"],
  [/\bpp\b/gi, "seorang"],
  [/\b&\b/g, "dan"],
  // Only word/word slashes are spoken as "atau" — never digits, which would
  // destroy dates like 23/12/2026 and 3/4 occupancy.
  [/(?<=\p{L})\s*\/\s*(?=\p{L})/gu, " atau "],
];

/**
 * Keep at most ONE honorific in the whole spoken note. Repeating "Datuk" in
 * every sentence is the single most script-like tell in Malay voice notes.
 */
export function limitHonorificRepetition(text: string): string {
  let seen = false;
  return text
    .replace(HONORIFICS, (match) => {
      if (!seen) {
        seen = true;
        return match;
      }
      return "\u0000";
    })
    // remove the placeholder plus the punctuation/whitespace it leaves behind
    .replace(/,?\s*\u0000\s*,?/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
}

/** Structure written for the eye (markdown, bullets, headings) is removed. */
export function stripWrittenFormatting(text: string): string {
  return text
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[*_`~>|]/g, "")
    .replace(/^\s*[-•–]\s*/gm, "")
    .replace(/^\s*\d+[.)]\s*/gm, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Prepare a written sales reply for speech WITHOUT rewriting its wording.
 * Deterministic and meaning-preserving.
 */
export function toSpeechScript(raw: string): string {
  let text = stripWrittenFormatting(raw ?? "");
  for (const [pattern, replacement] of EYE_ONLY_FORMS) text = text.replace(pattern, replacement);
  text = limitHonorificRepetition(text);
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*\./g, ".")
    .trim();
}
