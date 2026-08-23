/**
 * UMRAIO® — VOICE V1 PREPARATION (deterministic, no side effects).
 *
 * Classifies a single inbound WhatsApp webhook message BEFORE any database,
 * media, ASR or LLM work happens. Voice processing is NOT implemented yet:
 * `audio` is classified and reserved, never transcribed.
 */

export type InboundModality = "text" | "audio" | "unsupported";

export type InboundWebhookMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  voice?: { id?: string; mime_type?: string };
};

export type SenderSource = "from" | "wa_id" | "none";

/** Contact block from the same webhook `value`, used only for sender fallback. */
export type InboundWebhookContext = {
  /** `value.contacts[0].wa_id` — Meta's canonical sender identity. */
  contactWaId?: string | null;
};

export type ClassifiedInbound = {
  modality: InboundModality;
  /** Raw Meta message type, for safe logging only. */
  rawType: string;
  from: string;
  /** Which payload field the sender identity came from (safe to log). */
  senderSource: SenderSource;
  /** Verified message text. Empty for audio — never a fabricated transcript. */
  text: string;
  /** Meta media id for audio. Never the audio bytes. */
  mediaId: string | null;
  providerMessageId: string | null;
  /** True only when the message carries everything needed to be processed. */
  processable: boolean;
};

/**
 * Resolves the sender identity for an inbound message.
 *
 * Meta may omit `messages[0].from` (newer LID / privacy-style sender
 * identities). In that case `contacts[0].wa_id` from the SAME webhook value
 * carries the identity. Whatever wins is used verbatim downstream — there is
 * no separate LID pipeline and no per-sender special casing.
 */
export function resolveInboundSender(
  message: InboundWebhookMessage | null | undefined,
  context?: InboundWebhookContext | null,
): { from: string; senderSource: SenderSource } {
  const direct = message?.from?.trim() ?? "";
  if (direct) return { from: direct, senderSource: "from" };

  const waId = context?.contactWaId?.trim() ?? "";
  if (waId) return { from: waId, senderSource: "wa_id" };

  return { from: "", senderSource: "none" };
}

export function classifyInboundMessage(
  message: InboundWebhookMessage | null | undefined,
  context?: InboundWebhookContext | null,
): ClassifiedInbound {
  const rawType = message?.type?.trim() || "none";
  const { from, senderSource } = resolveInboundSender(message, context);
  const providerMessageId = message?.id?.trim() || null;

  if (rawType === "text") {
    const text = message?.text?.body ?? "";
    return {
      modality: "text",
      rawType,
      from,
      senderSource,
      text,
      mediaId: null,
      providerMessageId,
      processable: Boolean(from && text.trim()),
    };
  }

  if (rawType === "audio" || rawType === "voice") {
    const mediaId = (message?.audio?.id ?? message?.voice?.id ?? "").trim() || null;
    return {
      modality: "audio",
      rawType,
      from,
      senderSource,
      // Preparation phase: no transcript exists yet, and we never invent one.
      text: "",
      mediaId,
      providerMessageId,
      processable: Boolean(from && mediaId),
    };
  }

  return {
    modality: "unsupported",
    rawType,
    from,
    senderSource,
    text: "",
    mediaId: null,
    providerMessageId,
    processable: false,
  };
}


/** Persisted modality for the `messages` table (unsupported never persists). */
export function persistedModality(modality: InboundModality): "text" | "audio" {
  return modality === "audio" ? "audio" : "text";
}
