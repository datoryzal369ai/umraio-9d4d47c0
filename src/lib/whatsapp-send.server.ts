/**
 * Single outbound WhatsApp send path.
 *
 * Every automated outbound message (AI reply, follow-up dispatch, quotation
 * delivery) goes through here so credentials stay server-side and every send
 * is logged the same way.
 */

/**
 * P1-2 — every outbound Meta Graph call is bounded. A hung Meta connection must
 * fail cleanly instead of holding the webhook turn open indefinitely.
 */
const META_REQUEST_TIMEOUT_MS = 12_000;

async function metaFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detailed text send. Returns Meta's `wamid` so console sends can persist the
 * real provider message id. `sendWhatsappText` keeps its boolean contract for
 * every existing caller.
 */
export async function sendWhatsappTextDetailed(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<{ ok: boolean; providerMessageId: string | null }> {
  try {
    const res = await metaFetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
    if (!res.ok) {
      // Meta error bodies never contain the token; safe to log verbatim.
      console.error(`[whatsapp] outbound send failed status=${res.status} body=${await res.text()}`);
      return { ok: false, providerMessageId: null };
    }
    console.log(`[whatsapp] outbound send ok status=${res.status}`);
    const payload = (await res.json?.().catch(() => null)) as
      | { messages?: Array<{ id?: string }> }
      | null;
    return { ok: true, providerMessageId: payload?.messages?.[0]?.id ?? null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    console.error(
      `[whatsapp] outbound send failed reason=${aborted ? "timeout" : error instanceof Error ? error.name : "unknown"}`,
    );
    return { ok: false, providerMessageId: null };
  }
}

export async function sendWhatsappText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<boolean> {
  const result = await sendWhatsappTextDetailed(phoneNumberId, accessToken, to, body);
  return result.ok;
}


/**
 * Best-effort WhatsApp typing/processing indicator.
 *
 * Meta marks the inbound message as read and shows a typing bubble to the
 * customer while UMRAIO prepares the reply. Failure is never fatal and never
 * surfaces anything technical to the customer.
 */
export async function sendWhatsappTypingIndicator(
  phoneNumberId: string,
  accessToken: string,
  providerMessageId: string,
): Promise<boolean> {
  try {
    const res = await metaFetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: providerMessageId,
        typing_indicator: { type: "text" },
      }),
    });
    console.log(`[whatsapp] typing_indicator status=${res.status}`);
    return res.ok;
  } catch (error) {
    console.log(
      `[whatsapp] typing_indicator_failed reason=${error instanceof Error ? error.name : "unknown"}`,
    );
    return false;
  }
}

/**
 * B-4.4 — single Meta media upload path.
 *
 * Used by the AI voice reply AND by the console outbound media composer so the
 * multipart upload logic exists exactly once. Returns the Meta media id.
 */
export async function uploadWhatsappMedia(
  phoneNumberId: string,
  accessToken: string,
  media: { bytes: Uint8Array; mimeType: string; filename?: string },
): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", media.mimeType);
    form.append(
      "file",
      new Blob([media.bytes.slice() as unknown as BlobPart], { type: media.mimeType }),
      media.filename ?? "upload.bin",
    );

    const upload = await metaFetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
      method: "POST",
      // No Content-Type: the runtime sets the multipart boundary.
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    if (!upload.ok) {
      console.error(`[whatsapp] media_upload_failed status=${upload.status}`);
      return null;
    }
    const uploaded = (await upload.json().catch(() => null)) as { id?: string } | null;
    if (!uploaded?.id) {
      console.error("[whatsapp] media_upload_failed reason=missing_media_id");
      return null;
    }
    return uploaded.id;
  } catch (error) {
    console.error(
      `[whatsapp] media_upload_failed reason=${error instanceof Error ? error.name : "unknown"}`,
    );
    return null;
  }
}

/** Send an already-uploaded media id as an audio/image/document message. */
export async function sendWhatsappMediaMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  media: {
    kind: "audio" | "image" | "document";
    mediaId: string;
    caption?: string;
    filename?: string;
  },
): Promise<{ ok: boolean; providerMessageId: string | null }> {
  try {
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to,
      type: media.kind,
    };
    const object: Record<string, unknown> = { id: media.mediaId };
    if (media.kind !== "audio" && media.caption) object["caption"] = media.caption;
    if (media.kind === "document" && media.filename) object["filename"] = media.filename;
    payload[media.kind] = object;

    const res = await metaFetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[whatsapp] media_send_failed kind=${media.kind} status=${res.status}`);
      return { ok: false, providerMessageId: null };
    }
    const body = (await res.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }> }
      | null;
    return { ok: true, providerMessageId: body?.messages?.[0]?.id ?? null };
  } catch (error) {
    console.error(
      `[whatsapp] media_send_failed reason=${error instanceof Error ? error.name : "unknown"}`,
    );
    return { ok: false, providerMessageId: null };
  }
}

/**
 * VOICE REPLY V1 — outbound audio.
 *
 * Two-step Meta send (upload then reference). Behaviour unchanged; the upload
 * and send steps now reuse the shared helpers above. Failure is never fatal:
 * the caller has already delivered the same answer as text.
 */
export async function sendWhatsappAudio(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  audio: { bytes: Uint8Array; mimeType: string },
): Promise<boolean> {
  const mediaId = await uploadWhatsappMedia(phoneNumberId, accessToken, {
    bytes: audio.bytes,
    mimeType: audio.mimeType,
    filename: "reply.ogg",
  });
  if (!mediaId) {
    console.error("[whatsapp] voice_upload_failed");
    return false;
  }
  const result = await sendWhatsappMediaMessage(phoneNumberId, accessToken, to, {
    kind: "audio",
    mediaId,
  });
  if (!result.ok) {
    console.error("[whatsapp] voice_send_failed");
    return false;
  }
  console.log("[whatsapp] whatsapp_voice_sent ok=true");
  return true;
}

