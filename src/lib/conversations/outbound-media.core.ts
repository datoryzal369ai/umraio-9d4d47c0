/**
 * B-4.4 — OUTBOUND MEDIA COMPOSER (pure core).
 *
 * Browser-safe, deterministic validation shared by the composer UI and the
 * server function. No credentials, no network. The server ALWAYS re-runs these
 * checks: the browser copy exists only to fail fast with a clear message.
 */

export type OutboundMediaKind = "audio" | "image" | "document";

/** Meta-accepted, deliberately narrow allow-lists. */
export const OUTBOUND_AUDIO_MIME = [
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
] as const;
export const OUTBOUND_IMAGE_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp"] as const;
export const OUTBOUND_DOCUMENT_MIME = ["application/pdf"] as const;

/** Conservative ceilings, all below Meta's own limits. */
export const MAX_OUTBOUND_BYTES: Record<OutboundMediaKind, number> = {
  audio: 15 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  document: 20 * 1024 * 1024,
};

export type OutboundValidation =
  | { ok: true; kind: OutboundMediaKind; mimeType: string }
  | { ok: false; reason: "unsupported_type" | "too_large" | "empty"; message: string };

export function normalizeOutboundMime(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

export function kindForOutboundMime(raw: string | null | undefined): OutboundMediaKind | null {
  const mime = normalizeOutboundMime(raw);
  if ((OUTBOUND_AUDIO_MIME as readonly string[]).includes(mime)) return "audio";
  if ((OUTBOUND_IMAGE_MIME as readonly string[]).includes(mime)) return "image";
  if ((OUTBOUND_DOCUMENT_MIME as readonly string[]).includes(mime)) return "document";
  return null;
}

export function validateOutboundMedia(input: {
  mimeType: string | null | undefined;
  byteLength: number;
}): OutboundValidation {
  const mimeType = normalizeOutboundMime(input.mimeType);
  const kind = kindForOutboundMime(mimeType);
  if (!kind) {
    return {
      ok: false,
      reason: "unsupported_type",
      message: "This file type can't be sent on WhatsApp.",
    };
  }
  if (!Number.isFinite(input.byteLength) || input.byteLength <= 0) {
    return { ok: false, reason: "empty", message: "This file is empty." };
  }
  if (input.byteLength > MAX_OUTBOUND_BYTES[kind]) {
    return {
      ok: false,
      reason: "too_large",
      message: `This ${kind} is too large to send (max ${Math.round(
        MAX_OUTBOUND_BYTES[kind] / (1024 * 1024),
      )} MB).`,
    };
  }
  return { ok: true, kind, mimeType };
}

/**
 * Timeline body for an outbound media row. Media bytes are never persisted, so
 * the body is a short, PII-free label used by the existing renderer.
 */
export function outboundMediaBody(kind: OutboundMediaKind, filename?: string | null): string {
  if (kind === "audio") return "[Voice note sent]";
  if (kind === "image") return "[Image sent]";
  const name = (filename ?? "").trim();
  return name ? `[Document sent] ${name}` : "[Document sent]";
}

/** Recording containers we are willing to hand to Meta, in preference order. */
export const PREFERRED_RECORDING_MIME = ["audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Pure send-authorisation gate used by the server function.
 *
 * `conversation` is whatever the caller's OWN RLS-scoped read returned: a
 * cross-tenant or cross-conversation id resolves to `null` and is rejected
 * here, before any credential is read.
 */
export type OutboundAuthorization =
  | { ok: true; kind: OutboundMediaKind; mimeType: string; to: string; agencyId: string }
  | { ok: false; message: string };

export function authorizeOutboundSend(input: {
  conversation: { id: string; agency_id: string; lead?: { phone?: string | null } | null } | null;
  mimeType: string | null | undefined;
  byteLength: number;
}): OutboundAuthorization {
  if (!input.conversation) return { ok: false, message: "Conversation not found for this account." };
  const to = (input.conversation.lead?.phone ?? "").trim();
  if (!to) return { ok: false, message: "This contact has no WhatsApp number." };
  const validation = validateOutboundMedia({
    mimeType: input.mimeType,
    byteLength: input.byteLength,
  });
  if (!validation.ok) return { ok: false, message: validation.message };
  return {
    ok: true,
    kind: validation.kind,
    mimeType: validation.mimeType,
    to,
    agencyId: input.conversation.agency_id,
  };
}
