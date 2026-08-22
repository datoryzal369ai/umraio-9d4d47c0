/**
 * UMRAIO® VOICE V1 — secure server-side Meta media retrieval.
 *
 * SECURITY:
 *  - the agency access token never leaves the server and is never logged,
 *  - the temporary Meta media URL never leaves the server,
 *  - raw audio bytes are held in memory only and never persisted.
 */
import { MAX_VOICE_BYTES } from "./limits.core";

export type MediaFetchResult =
  | {
      ok: true;
      bytes: Uint8Array;
      byteLength: number;
      mimeType: string;
    }
  | { ok: false; reason: "media_unavailable" | "too_large" | "empty_audio" };

const GRAPH = "https://graph.facebook.com/v21.0";

export async function fetchWhatsappAudio(
  mediaId: string,
  accessToken: string,
): Promise<MediaFetchResult> {
  let metaUrl: string;
  let mimeType = "audio/ogg";
  let declaredSize = 0;

  try {
    const metaRes = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) {
      console.error(`[voice] media metadata failed status=${metaRes.status}`);
      return { ok: false, reason: "media_unavailable" };
    }
    const meta = (await metaRes.json()) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };
    if (!meta.url) return { ok: false, reason: "media_unavailable" };
    metaUrl = meta.url;
    mimeType = (meta.mime_type ?? mimeType).split(";")[0]!.trim();
    declaredSize = Number(meta.file_size ?? 0);
  } catch (error) {
    console.error(
      `[voice] media metadata error=${error instanceof Error ? error.name : "unknown"}`,
    );
    return { ok: false, reason: "media_unavailable" };
  }

  // Reject before downloading when Meta already tells us it is oversized.
  if (declaredSize > MAX_VOICE_BYTES) return { ok: false, reason: "too_large" };

  try {
    const binRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!binRes.ok) {
      console.error(`[voice] media download failed status=${binRes.status}`);
      return { ok: false, reason: "media_unavailable" };
    }
    const buffer = new Uint8Array(await binRes.arrayBuffer());
    if (buffer.byteLength === 0) return { ok: false, reason: "empty_audio" };
    if (buffer.byteLength > MAX_VOICE_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, bytes: buffer, byteLength: buffer.byteLength, mimeType };
  } catch (error) {
    console.error(`[voice] media download error=${error instanceof Error ? error.name : "unknown"}`);
    return { ok: false, reason: "media_unavailable" };
  }
}
