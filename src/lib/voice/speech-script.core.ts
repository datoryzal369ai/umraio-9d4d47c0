/**
 * UMRAIO® VOICE V4 — SPEECH SCRIPT LAYER.
 *
 *   AI SALES REPLY (written, CRM-grade)
 *      → SPEECH SCRIPT LAYER (this file)
 *      → VOICE PRESENTATION LAYER (rhythm + Malay normalisation)
 *      → OpenAI /v1/audio/speech
 *
 * PURE + DETERMINISTIC. No model call, no randomness.
 *
 * WHY: the text a customer READS is a written sales answer — formal register,
 * markdown, bullets, currency symbols, "Datuk" in every sentence. Feeding that
 * straight to TTS is exactly what makes a voice note sound like someone
 * READING A BROCHURE. This layer rewrites the same answer into how a Malaysian
 * Umrah consultant would actually SAY it.
 *
 * HARD RULE — FACTS ARE NEVER TOUCHED: prices, dates, hotel names, package
 * names, durations and religious content pass through unchanged. Only register
 * (word choice, honorific repetition, sentence length) is changed.
 */

/** Honorifics a Malaysian consultant uses — spoken at most ONCE per note. */
const HONORIFICS = /\b(Datuk|Dato'|Datin|Tuan|Puan|Encik|Cik)\b/g;

/**
 * Written → spoken register. Left side is formal/administrative Malay that
 * makes TTS sound like a circular; right side is what people actually say.
 * Meaning is identical in every pair.
 */
const SPOKEN_REGISTER: Array<[RegExp, string]> = [
  [/\bsekiranya\b/gi, "kalau"],
  [/\bsekiranya\s+berminat\b/gi, "kalau berminat"],
  [/\bjika\b/gi, "kalau"],
  [/\bandai\b/gi, "kalau"],
  [/\btersebut\b/gi, "tu"],
  [/\bini\s+adalah\b/gi, "ini"],
  [/\bmerupakan\b/gi, "memang"],
  [/\bselain\s+itu\b/gi, "lepas tu"],
  [/\bdi\s+samping\s+itu\b/gi, "lepas tu"],
  [/\bseterusnya\b/gi, "lepas tu"],
  [/\bwalau\s+bagaimanapun\b/gi, "tapi"],
  [/\bnamun\s+begitu\b/gi, "tapi"],
  [/\bnamun\b/gi, "tapi"],
  [/\boleh\s+yang\s+demikian\b/gi, "jadi"],
  [/\bdengan\s+itu\b/gi, "jadi"],
  [/\bmaka\b/gi, "jadi"],
  [/\bmemaklumkan\b/gi, "beritahu"],
  [/\bmaklumat\s+lanjut\b/gi, "detail"],
  [/\bpertanyaan\b/gi, "soalan"],
  [/\bmenyediakan\b/gi, "ada"],
  [/\bdisediakan\b/gi, "ada"],
  [/\bmengandungi\b/gi, "ada"],
  [/\btermasuklah\b/gi, "termasuk"],
  [/\bpenginapan\b/gi, "hotel"],
  [/\bberhampiran\s+dengan\b/gi, "dekat dengan"],
  [/\bberhampiran\b/gi, "dekat dengan"],
  [/\bboleh\s+dipertimbangkan\b/gi, "boleh"],
  [/\bkami\s+ingin\s+memaklumkan\s+bahawa\b/gi, "saya nak beritahu"],
  [/\bharga\s+bagi\s+pakej\b/gi, "harga pakej"],
  [/\bpada\s+harga\s+sebanyak\b/gi, "harganya"],
  [/\bsebanyak\s+(?=RM)/gi, ""],
  [/\bbagi\s+setiap\s+orang\b/gi, "seorang"],
  [/\bsetiap\s+peserta\b/gi, "seorang"],
  [/\bper\s+pax\b/gi, "seorang"],
  [/\bsila\s+maklumkan\b/gi, "bagitahu saya"],
  [/\bsila\s+nyatakan\b/gi, "bagitahu saya"],
  [/\bsila\b/gi, "boleh"],
  [/\bterima\s+kasih\s+kerana\s+menghubungi\s+kami\b/gi, "terima kasih sebab hubungi kami"],
  [/\bAdakah\s+anda\s+berminat\b/gi, "Kalau berminat"],
  [/\bharap\s+maklum\b/gi, ""],
];

/** Currency and shorthand written for the eye, not the ear. */
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
 * One long written sentence becomes two spoken ones at a natural Malay clause
 * boundary. Voice notes breathe; written answers do not.
 */
function breakLongSentences(text: string, maxChars = 120): string {
  const sentences = (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  return sentences
    .map((sentence) => {
      if (sentence.length <= maxChars) return sentence;
      const split = sentence.replace(
        /,\s+(tapi|jadi|kalau|lepas tu|sebab|untuk)\s+/i,
        (_m, w) => `. ${String(w).charAt(0).toUpperCase()}${String(w).slice(1)} `,
      );
      return split;
    })
    .join(" ");
}

/**
 * Turn a written sales reply into a spoken Malaysian Malay script.
 *
 * Deterministic and meaning-preserving: it changes REGISTER, never FACTS.
 */
export function toSpeechScript(raw: string): string {
  let text = stripWrittenFormatting(raw ?? "");
  for (const [pattern, replacement] of EYE_ONLY_FORMS) text = text.replace(pattern, replacement);
  for (const [pattern, replacement] of SPOKEN_REGISTER) text = text.replace(pattern, replacement);
  text = limitHonorificRepetition(text);
  text = breakLongSentences(text);
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*\./g, ".")
    .trim();
}
