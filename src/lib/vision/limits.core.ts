/**
 * UMRAIO® IMAGE V1 — deterministic limits and customer-facing fallbacks.
 *
 * Image is only a new INPUT modality. Nothing here knows about sales or the
 * persona — it only decides whether an inbound image is safe to send to the
 * vision model, and what the customer is told when it is not.
 */

/** Maximum accepted downloaded image size (bytes). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Provider-supported inbound image types. Anything else is refused politely. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type ImageRejection =
  | "too_large"
  | "empty_image"
  | "unsupported_media"
  | "media_unavailable"
  | "quota_exceeded"
  | "vision_failed";

export const IMAGE_FALLBACK_MESSAGE =
  "Maaf, saya tak dapat melihat gambar itu dengan jelas. Boleh hantar semula gambar yang lebih jelas, atau taip maklumat itu?";

export const IMAGE_TOO_LARGE_MESSAGE =
  "Maaf, gambar itu terlalu besar untuk saya proses. Boleh hantar gambar yang lebih kecil atau taip maklumat itu?";

export const IMAGE_UNSUPPORTED_MESSAGE =
  "Maaf, format gambar itu tidak disokong. Boleh hantar dalam format JPG atau PNG, atau taip maklumat itu?";

export const IMAGE_QUOTA_MESSAGE =
  "Maaf, saya tak dapat memproses gambar buat masa ini. Boleh taip maklumat itu?";

export function imageFallbackMessageFor(reason: ImageRejection): string {
  if (reason === "too_large") return IMAGE_TOO_LARGE_MESSAGE;
  if (reason === "unsupported_media") return IMAGE_UNSUPPORTED_MESSAGE;
  if (reason === "quota_exceeded") return IMAGE_QUOTA_MESSAGE;
  return IMAGE_FALLBACK_MESSAGE;
}

export function normalizeImageMimeType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

export function isSupportedImageMimeType(raw: string | null | undefined): boolean {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(normalizeImageMimeType(raw));
}

/** Pre-flight size/type gate, run BEFORE any vision call. */
export function checkImageLimits(args: {
  bytes: number;
  mimeType?: string | null;
}): { ok: true } | { ok: false; reason: ImageRejection } {
  if (!Number.isFinite(args.bytes) || args.bytes <= 0) return { ok: false, reason: "empty_image" };
  if (args.bytes > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
  if (args.mimeType !== undefined && !isSupportedImageMimeType(args.mimeType)) {
    return { ok: false, reason: "unsupported_media" };
  }
  return { ok: true };
}

/** Text the vision model must return when it genuinely cannot read the image. */
export const VISION_UNREADABLE_TOKEN = "UNREADABLE";

export function isUnreadableDescription(text: string): boolean {
  return text.trim().toUpperCase().startsWith(VISION_UNREADABLE_TOKEN);
}

/**
 * The message the EXISTING text pipeline receives. The description is clearly
 * attributed as an image observation — it is never presented as words the
 * customer typed, and the customer's own caption is preserved verbatim.
 */
export function buildImageMessageText(args: { description: string; caption?: string | null }): string {
  const caption = (args.caption ?? "").trim();
  const description = args.description.replace(/\s+/g, " ").trim();
  const parts = [`[Gambar daripada pelanggan] ${description}`];
  if (caption) parts.push(`[Kapsyen pelanggan] ${caption}`);
  return parts.join("\n");
}
