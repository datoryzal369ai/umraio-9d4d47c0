/**
 * B-4.3 — READ-ONLY MEDIA RENDERING (pure core).
 *
 * Deterministic, browser-safe helpers that turn a persisted `messages` row
 * into a renderable media descriptor. No credentials, no network, no AI.
 */
import type { ChatMessage } from "@/lib/conversations";

export type MediaKind = "text" | "audio" | "image" | "document" | "unknown";

export type MediaDescriptor = {
  kind: MediaKind;
  /** True when the row has a resolvable provider media reference. */
  resolvable: boolean;
  mediaId: string | null;
  /** Voice-note transcript (audio) — null when transcription produced nothing. */
  transcript: string | null;
  /** Grounded description / caption for an image. */
  caption: string | null;
  /** Document filename when known. */
  filename: string | null;
  /** Concise, non-technical status line for failed or pending media. */
  status: string | null;
};

/** Vision pipeline prefixes the grounded description with this marker. */
const IMAGE_PREFIX = /^\s*\[[^\]]*\]\s*/;

const AUDIO_MIME = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/webm"];
const IMAGE_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
const DOCUMENT_MIME = ["application/pdf"];

export function normalizeMime(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

/** MIME validation gate — the browser only renders types we explicitly allow. */
export function isRenderableMime(kind: MediaKind, raw: string | null | undefined): boolean {
  const mime = normalizeMime(raw);
  if (!mime) return false;
  if (kind === "audio") return AUDIO_MIME.includes(mime);
  if (kind === "image") return IMAGE_MIME.includes(mime);
  if (kind === "document") return DOCUMENT_MIME.includes(mime);
  return false;
}

export function mediaKindOf(modality: string | null | undefined): MediaKind {
  const value = (modality ?? "text").toLowerCase();
  if (value === "text") return "text";
  if (value === "audio") return "audio";
  if (value === "image") return "image";
  if (value === "document") return "document";
  return "unknown";
}

/**
 * Build the descriptor used by the conversation timeline.
 *
 * Never throws: an unknown modality or a media row without a `media_id`
 * degrades into a safe fallback card instead of breaking the timeline.
 */
export function describeMessageMedia(
  message: Pick<ChatMessage, "body" | "modality" | "media_id" | "delivery_status">,
): MediaDescriptor {
  const kind = mediaKindOf(message.modality);
  const mediaId = message.media_id ?? null;
  const body = (message.body ?? "").trim();

  if (kind === "text") {
    return {
      kind,
      resolvable: false,
      mediaId: null,
      transcript: null,
      caption: null,
      filename: null,
      status: null,
    };
  }

  const resolvable = Boolean(mediaId);
  const base: MediaDescriptor = {
    kind,
    resolvable,
    mediaId,
    transcript: null,
    caption: null,
    filename: null,
    status: resolvable ? null : "Media received — no longer available from WhatsApp",
  };

  if (kind === "audio") {
    return {
      ...base,
      transcript: body || null,
      status: body ? base.status : "Voice note received — transcription unavailable",
    };
  }

  if (kind === "image") {
    const caption = body.replace(IMAGE_PREFIX, "").trim();
    return { ...base, caption: caption || null };
  }

  if (kind === "document") {
    const filename = body.match(/([\w .,'()-]+\.pdf)/i)?.[1] ?? null;
    return { ...base, filename, caption: body || null };
  }

  return { ...base, status: base.status ?? "Media received" };
}

/** Human label used by the fallback card and the document row. */
export function mediaKindLabel(kind: MediaKind): string {
  if (kind === "audio") return "Voice note";
  if (kind === "image") return "Image";
  if (kind === "document") return "Document";
  if (kind === "text") return "Message";
  return "Media received";
}

/** Format a duration in seconds as m:ss. Returns null when unknown. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
