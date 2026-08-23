/**
 * UMRAIO® VOICE REPLY — pure, engine-agnostic speech preparation.
 *
 * V2 moved the real work into the Voice Presentation Layer
 * (`presentation.core.ts`). This module stays as the stable entry point so
 * every existing caller keeps working unchanged.
 */

export {
  MAX_OUTBOUND_AUDIO_BYTES,
  MAX_SPEECH_CHARS,
  SPOKEN_REPLY_CHAR_LIMIT,
  TARGET_SPEECH_CHARS,
  classifySpokenLength,
  decideVoiceReply,
  isDeliverableAudio,
  prepareSpokenResponse,
  type SpokenLengthClass,
  type VoicePresentation,
  type VoiceReplyDecision,
} from "./presentation.core";

import { stripForSpeech } from "./presentation.core";

/**
 * Back-compatible helper: sanitising only (markdown, URLs, emoji, internal
 * references). Prefer `prepareSpokenResponse` for full V2 preparation.
 */
export function toSpeakableText(raw: string): string {
  const cleaned = stripForSpeech(raw ?? "")
    .split("\n")
    .map((line) => {
      const l = line.trim();
      if (!l) return "";
      return /[.!?,:]$/.test(l) ? l : `${l}.`;
    })
    .filter(Boolean)
    .join(" ");
  return cleaned.replace(/\s{2,}/g, " ").trim();
}
