/**
 * UMRAIO® — VOICE V1 PREPARATION (deterministic, no side effects).
 *
 * Classifies a single inbound WhatsApp webhook message BEFORE any database,
 * media, ASR or LLM work happens. Voice processing is NOT implemented yet:
 * `audio` is classified and reserved, never transcribed.
 */

export type InboundModality = "text" | "audio" | "image" | "document" | "unsupported";

/** DOCUMENT V1 — only PDFs are classified as documents in this step. */
export const SUPPORTED_DOCUMENT_MIME = "application/pdf";

export type InboundWebhookMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  voice?: { id?: string; mime_type?: string };
  image?: { id?: string; mime_type?: string; caption?: string; sha256?: string };
  document?: {
    id?: string;
    filename?: string;
    mime_type?: string;
    file_size?: number;
    caption?: string;
    sha256?: string;
  };
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
  /** Verified message text. Empty for audio/image — never fabricated content. */
  text: string;
  /** Customer caption sent with an image, if any. Verbatim. */
  caption: string | null;
  /** Meta media id for audio/image. Never the media bytes. */
  mediaId: string | null;
  providerMessageId: string | null;

  /** DOCUMENT V1 — original filename, verbatim. Null unless a document. */
  filename: string | null;
  /** DOCUMENT V1 — declared MIME type. Null unless a document. */
  mimeType: string | null;
  /** DOCUMENT V1 — declared size in bytes. Null unless known. */
  fileSize: number | null;

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
      caption: null,
      mediaId: null,
      providerMessageId,
      filename: null,
      mimeType: null,
      fileSize: null,
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
      caption: null,
      mediaId,
      providerMessageId,
      processable: Boolean(from && mediaId),
    };
  }

  // IMAGE V1 — the image itself is understood later by the vision gateway.
  if (rawType === "image") {
    const mediaId = (message?.image?.id ?? "").trim() || null;
    const caption = (message?.image?.caption ?? "").trim() || null;
    return {
      modality: "image",
      rawType,
      from,
      senderSource,
      // No description exists yet, and we never invent one.
      text: "",
      caption,
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
    caption: null,
    mediaId: null,
    providerMessageId,
    processable: false,
  };
}


/** Persisted modality for the `messages` table (unsupported never persists). */
export function persistedModality(modality: InboundModality): "text" | "audio" | "image" {
  if (modality === "audio") return "audio";
  if (modality === "image") return "image";
  return "text";

}
