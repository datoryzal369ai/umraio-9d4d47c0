/**
 * UMRAIO® VOICE V1 — audio media retrieval.
 *
 * Thin, behaviour-preserving wrapper over the shared Meta media helper
 * (see src/lib/whatsapp/media.server.ts). Audio semantics are unchanged.
 */
import { fetchWhatsappMedia } from "@/lib/whatsapp/media.server";

import { MAX_VOICE_BYTES } from "./limits.core";

export type MediaFetchResult =
  | {
      ok: true;
      bytes: Uint8Array;
      byteLength: number;
      mimeType: string;
    }
  | { ok: false; reason: "media_unavailable" | "too_large" | "empty_audio" };

export async function fetchWhatsappAudio(
  mediaId: string,
  accessToken: string,
): Promise<MediaFetchResult> {
  const result = await fetchWhatsappMedia(mediaId, accessToken, {
    maxBytes: MAX_VOICE_BYTES,
    defaultMimeType: "audio/ogg",
    logPrefix: "voice",
  });
  if (result.ok) return result;
  return { ok: false, reason: result.reason === "empty_media" ? "empty_audio" : result.reason };
}
