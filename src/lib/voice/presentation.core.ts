/**
 * UMRAIO® VOICE NATURALNESS V2 — the Voice Presentation Layer.
 *
 *   AI RESPONSE → VOICE PRESENTATION LAYER → SPOKEN RESPONSE → TTS
 *
 * PURE + DETERMINISTIC. The text the customer reads is never changed; this
 * layer only produces the SPOKEN rendering of that same answer.
 *
 * HARD RULE: meaning is preserved. Prices, dates, package names, religious
 * content and commitments are only ever converted from written form to spoken
 * form (RM5,990 → "lima ribu sembilan ratus sembilan puluh ringgit"). Nothing
 * is summarised away, softened or invented.
 */

import { resolveVoiceLanguage, usesMalayNormalisation } from "./language.core";
import { toSpeechScript } from "./speech-script.core";
import { normaliseMalaySpeech } from "./malay-speech.core";
import {
  buildVoiceInstructions,
  paceToSpeed,
  resolvePersona,
  type VoiceControls,
  type VoicePersonaKey,
} from "./persona.core";

/** Hard cap on characters sent to any voice engine (~60s of speech). */
export const MAX_SPEECH_CHARS = 700;

/** Replies longer than this stay text-only: itineraries are read, not heard. */
export const SPOKEN_REPLY_CHAR_LIMIT = 700;

/**
 * Target spoken length for a normal sales answer: 10–18 seconds of Malay
 * speech (~14 chars/second). Non-verbatim answers longer than this are
 * condensed at sentence boundaries so a voice note never rambles.
 */
export const TARGET_SPEECH_CHARS = 250;

/** Maximum outbound audio accepted for a WhatsApp voice reply. */
export const MAX_OUTBOUND_AUDIO_BYTES = 8 * 1024 * 1024;

/** Rough Malay speaking rate used only for duration ESTIMATES in logs/UI. */
const CHARS_PER_SECOND = 14;

export type SpokenLengthClass = "short" | "normal" | "detailed" | "too_long";

/* --------------------------------------------------------------------- */
/* 1. Sanitisation — anything meaningful to the eye but noise to the ear   */
/* --------------------------------------------------------------------- */

/** Internal worker / system vocabulary that must never be read aloud. */
const INTERNAL_TERMS =
  /\b(ai_tasks?|islamic_reviews?|agency_id|conversation_id|lead_id|quotation_id|supabase|webhook|payload|worker_key|sales_elite|lead_intel|ai\s+whatsapp\s+executive|ai\s+marketing\s+executive|ai\s+content\s+executive|ai\s+lead\s+intelligence|status\s*[:=]\s*(pending|approved|rejected|amended))\b/gi;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Written-Malay → spoken-Malay swaps were REMOVED after the V4 experiment:
 * deterministic register rewriting produced artificial slang. Conversational
 * tone now comes from the source text and the TTS engine instructions.
 */


const HONORIFIC_OPENING =
  /^(baik|baiklah|ok|okay|terima kasih)[,!.]?\s*(datuk|tuan|puan|encik|cik)?[,.!]?\s*/i;

export function stripForSpeech(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/www\.\S+/g, "")
    .replace(/\b\S+@\S+\.\w{2,}\b/g, "")
    .replace(UUID, "")
    .replace(/\b[A-Z]{2,4}-[A-Z0-9]{3,}\b/g, "")
    .replace(/\((?:ruj|ref|rujukan|reference)[^)]*\)/gi, "")
    .replace(INTERNAL_TERMS, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_`~>|]/g, "")
    .replace(/^\s*\d+[.)]\s*/gm, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/* --------------------------------------------------------------------- */
/* 2. Rhythm — spoken units, not paragraphs                                */
/* --------------------------------------------------------------------- */

/** Bullet/newline structure becomes spoken structure, not a recited list. */
function listsToSpokenStructure(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";
  const [head, ...rest] = lines;
  const headIsLabel = /[:：]$/.test(head!);
  const items = rest.map((l) => l.replace(/[.;,]$/, ""));
  const joined =
    items.length > 1
      ? `${items.slice(0, -1).join(", ")} dan ${items[items.length - 1]}`
      : (items[0] ?? "");
  const headText = headIsLabel ? head!.replace(/[:：]$/, "") : head!;
  return `${headText}${headIsLabel ? ": " : ". "}${joined}.`;
}

/** Long run-on clauses become short breathable sentences. */
function shapeRhythm(text: string, pause: number): string {
  const sentences = (text.match(/[^.!?]+[.!?]*/g) ?? [text])
    .map((s) => s.trim())
    .filter(Boolean);
  const shaped = sentences.map((sentence) => {
    let s = sentence;
    if (pause >= 45) {
      // Clause boundaries a Malaysian speaker naturally breathes at. At most
      // ONE per sentence: more turns the delivery into a metronome.
      let inserted = false;
      s = s.replace(
        /\s+(tapi|jadi|kerana|sebab|kalau|untuk|lepas itu|selain itu)\s+/gi,
        (m, w) => {
          if (inserted) return m;
          inserted = true;
          return `, ${String(w).toLowerCase()} `;
        },
      );
    }
    if (pause <= 25) s = s.replace(/,\s+/g, " ");
    if (!/[.!?,:]$/.test(s)) s = `${s}.`;
    return s;
  });
  return shaped.join(" ").replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").trim();
}

/**
 * Keep a voice note inside the 10–18s target by dropping trailing sentences
 * (never mid-sentence), while preserving the closing question if there is one.
 */
function condenseToTarget(text: string, limit = TARGET_SPEECH_CHARS): string {
  if (text.length <= limit) return text;
  const sentences = (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 1) return text;
  const closing = sentences[sentences.length - 1]!.endsWith("?")
    ? sentences[sentences.length - 1]!
    : null;
  const body = closing ? sentences.slice(0, -1) : sentences;
  const budget = closing ? limit - closing.length - 1 : limit;
  const kept: string[] = [];
  let used = 0;
  for (const sentence of body) {
    // Keep going while there is budget. A short lead-in sentence (a package
    // title, "Baik.") must never be the ONLY thing spoken — the next sentence
    // usually carries the price/date fact, so allow it through.
    const leadInOnly = kept.length === 1 && used < limit / 2;
    if (kept.length && !leadInOnly && used + sentence.length + 1 > budget) break;
    kept.push(sentence);
    used += sentence.length + 1;
  }
  const out = [...kept, ...(closing ? [closing] : [])].join(" ").trim();
  return out || sentences[0]!;
}


/** Do not append a question to every reply; keep at most one closing ask. */
function trimForcedEngagement(text: string): string {
  const sentences = (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  const questions = sentences.filter((s) => s.endsWith("?"));
  if (questions.length <= 1) return sentences.join(" ");
  // Keep the first question, drop later redundant confirmations.
  let seen = false;
  return sentences
    .filter((s) => {
      if (!s.endsWith("?")) return true;
      if (seen) return false;
      seen = true;
      return true;
    })
    .join(" ");
}

/* --------------------------------------------------------------------- */
/* 3. Public API                                                           */
/* --------------------------------------------------------------------- */

export type VoicePresentationInput = {
  replyText: string;
  persona?: { persona?: string | null; controls?: Record<string, unknown> | null; voice?: string | null };
  language?: string;
  /** Approved Islamic rulings and Arabic text are spoken verbatim. */
  preserveVerbatim?: boolean;
  /** Opening honorific already used on the previous voice turn. */
  lastOpening?: string | null;
};

export type VoicePresentation = {
  spokenText: string;
  personaKey: VoicePersonaKey;
  controls: VoiceControls;
  voice: string;
  speed: number;
  instructions: string;
  verbatim: boolean;
  estimatedSeconds: number;
  lengthClass: SpokenLengthClass;
  opening: string | null;
};

export function classifySpokenLength(seconds: number): SpokenLengthClass {
  if (seconds <= 10) return "short";
  if (seconds <= 20) return "normal";
  if (seconds <= 40) return "detailed";
  return "too_long";
}

/**
 * Convert an AI text answer into the spoken rendering of the SAME answer.
 * `preserveVerbatim` (approved Islamic answers, Arabic text) skips every
 * conversational rewrite and applies only sanitising of non-speech artefacts.
 */
export function prepareSpokenResponse(input: VoicePresentationInput): VoicePresentation {
  const persona = resolvePersona(input.persona);
  const controls = persona.controls;
  // voice_language is authoritative; a missing value means Malaysian Malay.
  const language = resolveVoiceLanguage(input.language);
  const isMalay = usesMalayNormalisation(language);

  let text = stripForSpeech(input.replyText ?? "");
  text = listsToSpokenStructure(text);

  let opening: string | null = null;
  if (!input.preserveVerbatim) {
    // Avoid "Baik Datuk..." on every single turn.
    const match = text.match(HONORIFIC_OPENING);
    if (match) {
      opening = match[0].trim();
      if (input.lastOpening && opening.toLowerCase() === input.lastOpening.toLowerCase()) {
        text = text.slice(match[0].length).trim();
        text = text.charAt(0).toUpperCase() + text.slice(1);
      }
    }
    // SPEECH SCRIPT LAYER: removes eye-only formatting and shorthand and keeps
    // one honorific per note. It does NOT reword the reply.
    text = toSpeechScript(text);

    text = trimForcedEngagement(text);
    text = condenseToTarget(text);
    text = shapeRhythm(text, controls.pause);
    if (isMalay) text = normaliseMalaySpeech(text);
  } else if (isMalay) {
    // Verbatim answers still need digits spoken as words, never reworded.
    text = normaliseMalaySpeech(text);
  }

  text = text.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  const spokenText = text.slice(0, MAX_SPEECH_CHARS);
  const estimatedSeconds = Math.max(1, Math.round(spokenText.length / CHARS_PER_SECOND));

  return {
    spokenText,
    personaKey: persona.key,
    controls,
    voice: persona.voice,
    speed: paceToSpeed(controls.pace),
    instructions: buildVoiceInstructions(controls, language),
    verbatim: Boolean(input.preserveVerbatim),
    estimatedSeconds,
    lengthClass: classifySpokenLength(estimatedSeconds),
    opening,
  };
}

export type VoiceReplyDecision =
  | { speak: true; presentation: VoicePresentation; text: string }
  | { speak: false; reason: "not_voice_turn" | "empty_reply" | "too_long" | "pending_islamic_review" };

/**
 * A spoken reply is only produced for a turn that ARRIVED as voice, is short
 * enough to be pleasant to hear, and is never an unverified religious ruling.
 */
export function decideVoiceReply(input: {
  inboundModality: string;
  replyText: string;
  persona?: VoicePresentationInput["persona"];
  language?: string;
  preserveVerbatim?: boolean;
  lastOpening?: string | null;
  islamicReviewPending?: boolean;
}): VoiceReplyDecision {
  if (input.inboundModality !== "audio") return { speak: false, reason: "not_voice_turn" };
  if (input.islamicReviewPending) return { speak: false, reason: "pending_islamic_review" };
  const presentation = prepareSpokenResponse({
    replyText: input.replyText,
    ...(input.persona ? { persona: input.persona } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.preserveVerbatim ? { preserveVerbatim: true } : {}),
    ...(input.lastOpening ? { lastOpening: input.lastOpening } : {}),
  });
  if (!presentation.spokenText) return { speak: false, reason: "empty_reply" };
  if ((input.replyText ?? "").length > SPOKEN_REPLY_CHAR_LIMIT) {
    return { speak: false, reason: "too_long" };
  }
  return { speak: true, presentation, text: presentation.spokenText };
}

export function isDeliverableAudio(input: { byteLength: number }): boolean {
  return input.byteLength > 0 && input.byteLength <= MAX_OUTBOUND_AUDIO_BYTES;
}
