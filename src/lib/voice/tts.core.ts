/**
 * UMRAIO® VOICE REPLY V1 — pure, engine-agnostic speech preparation.
 *
 * Nothing here talks to a provider, the database or WhatsApp. It only decides
 * WHETHER a reply should be spoken and WHAT text the voice engine receives.
 */

/** Hard cap on characters sent to any voice engine (roughly ~60s of speech). */
export const MAX_SPEECH_CHARS = 700;

/** Replies longer than this stay text-only: prices/itineraries are read, not heard. */
export const SPOKEN_REPLY_CHAR_LIMIT = 700;

/** Maximum outbound audio accepted for a WhatsApp voice reply (Meta caps at 16 MB). */
export const MAX_OUTBOUND_AUDIO_BYTES = 8 * 1024 * 1024;

export type VoiceReplyDecision =
  | { speak: true; text: string }
  | { speak: false; reason: "not_voice_turn" | "empty_reply" | "too_long" };

/**
 * Strip anything that is meaningful to the eye but noise to the ear:
 * markdown, bullets, emoji, raw URLs. The wording itself is never rewritten.
 */
export function toSpeakableText(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>~]/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu,
      "",
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * A spoken reply is only produced for a turn that ARRIVED as voice, and only
 * when the answer is short enough to be pleasant to listen to.
 */
export function decideVoiceReply(input: {
  inboundModality: string;
  replyText: string;
}): VoiceReplyDecision {
  if (input.inboundModality !== "audio") return { speak: false, reason: "not_voice_turn" };
  const text = toSpeakableText(input.replyText ?? "");
  if (!text) return { speak: false, reason: "empty_reply" };
  if (text.length > SPOKEN_REPLY_CHAR_LIMIT) return { speak: false, reason: "too_long" };
  return { speak: true, text: text.slice(0, MAX_SPEECH_CHARS) };
}

export function isDeliverableAudio(input: { byteLength: number }): boolean {
  return input.byteLength > 0 && input.byteLength <= MAX_OUTBOUND_AUDIO_BYTES;
}
