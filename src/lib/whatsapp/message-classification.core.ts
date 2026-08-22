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

export type ClassifiedInbound = {
  modality: InboundModality;
  /** Raw Meta message type, for safe logging only. */
  rawType: string;
  from: string;
  /** Verified message text. Empty for audio — never a fabricated transcript. */
  text: string;
  /** Meta media id for audio. Never the audio bytes. */
  mediaId: string | null;
  providerMessageId: string | null;
  /** True only when the message carries everything needed to be processed. */
  processable: boolean;
};

export function classifyInboundMessage(
  message: InboundWebhookMessage | null | undefined,
): ClassifiedInbound {
  const rawType = message?.type?.trim() || "none";
  const from = message?.from?.trim() ?? "";
  const providerMessageId = message?.id?.trim() || null;

  if (rawType === "text") {
    const text = message?.text?.body ?? "";
    return {
      modality: "text",
      rawType,
      from,
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
