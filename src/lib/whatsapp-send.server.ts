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
    return await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detailed text send. Returns Meta's `wamid` so console sends can persist the
 * real provider message id. `sendWhatsappText` keeps its boolean contract for
 * every existing caller.
 */
export type WhatsappSendOutcome = "verified_success" | "verified_failure" | "cancelled" | "timeout" | "outcome_unknown";
export type WhatsappSendControl = { signal: AbortSignal; timeoutMs?: number };
export type WhatsappSendResult = { ok: boolean; providerMessageId: string | null;
  outcome?: WhatsappSendOutcome; cause?: "cancelled" | "timeout" | "provider_rejection" | "network" | "unverified_receipt";
  dispatched?: boolean; httpStatus?: number | null };

export async function sendWhatsappTextDetailed(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  control?: WhatsappSendControl,
): Promise<WhatsappSendResult> {
  // Optional Calling owner survives headers and covers receipt consumption.
  // Without it, existing callers keep their exact request/result behaviour.
  const deadline = control ? new AbortController() : null;
  const signal = control && deadline ? AbortSignal.any([control.signal, deadline.signal]) : undefined;
  const budget = Number.isFinite(control?.timeoutMs) ? Math.max(1, Math.min(META_REQUEST_TIMEOUT_MS, control!.timeoutMs!)) : META_REQUEST_TIMEOUT_MS;
  const timer = deadline ? setTimeout(() => deadline.abort(new DOMException("Receipt deadline", "TimeoutError")), budget) : undefined;
  let dispatched = false;
  let httpStatus: number | null = null;
  try {
    signal?.throwIfAborted();
    dispatched = true;
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
      ...(signal ? { signal } : {}),
    });
    httpStatus = res.status;
    if (!res.ok) {
      if (control) {
        const payload = await res.json().catch(error => { if (signal?.aborted) throw error; return null; }) as { error?: { code?: unknown } } | null;
        // Only a complete explicit rejection establishes failure. A gateway
        // timeout, server error or incomplete body cannot prove non-delivery.
        const rejected = res.status >= 400 && res.status < 500 && res.status !== 408 && typeof payload?.error?.code === "number";
        return { ok: false, providerMessageId: null, outcome: rejected ? "verified_failure" : "outcome_unknown",
          cause: rejected ? "provider_rejection" : "unverified_receipt", dispatched, httpStatus };
      }
      // Meta error bodies never contain the token; safe to log verbatim.
      console.error(`[whatsapp] outbound send failed status=${res.status} body=${await res.text()}`);
      return { ok: false, providerMessageId: null };
    }
    if (!control) console.log(`[whatsapp] outbound send ok status=${res.status}`);
    const payload = (await res.json?.().catch(error => { if (control && signal?.aborted) throw error; return null; })) as
      | { messages?: Array<{ id?: string }> }
      | null;
    if (control) {
      const id = payload?.messages?.[0]?.id;
      const receipt = typeof id === "string" && id.trim() ? id : null;
      return { ok: receipt !== null, providerMessageId: receipt, outcome: receipt ? "verified_success" : "outcome_unknown",
        ...(receipt ? {} : { cause: "unverified_receipt" as const }), dispatched, httpStatus };
    }
    return { ok: true, providerMessageId: payload?.messages?.[0]?.id ?? null };
  } catch (error) {
    if (control) {
      const cancelled = signal?.aborted === true;
      const timedOut = deadline?.signal.aborted || (cancelled && signal?.reason?.name === "TimeoutError");
      const cause = timedOut ? "timeout" : cancelled ? "cancelled" : "network";
      return { ok: false, providerMessageId: null, outcome: dispatched ? "outcome_unknown" : timedOut ? "timeout" : "cancelled",
        cause, dispatched, httpStatus };
    }
    const aborted = error instanceof Error && error.name === "AbortError";
    console.error(
      `[whatsapp] outbound send failed reason=${aborted ? "timeout" : error instanceof Error ? error.name : "unknown"}`,
    );
    return { ok: false, providerMessageId: null };
  } finally {
    clearTimeout(timer);
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
      // Meta error bodies never contain the token; safe to log verbatim.
      const detail = await upload.text().catch(() => "");
      console.error(
        `[whatsapp] media_upload_failed status=${upload.status} mime=${media.mimeType} filename=${media.filename ?? "none"} body=${detail}`,
      );
      return null;
    }

    const uploaded = (await upload.json().catch(() => null)) as { id?: string } | null;
    if (!uploaded?.id) {
      console.error("[whatsapp] media_upload_failed reason=missing_media_id");
      return null;
    }
    console.log(
      `[whatsapp] media_upload_ok mime=${media.mimeType} filename=${media.filename ?? "none"} media_id=${uploaded.id}`,
    );
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
    voice?: boolean;
  },
): Promise<{ ok: boolean; providerMessageId: string | null }> {
  try {
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to,
      type: media.kind,
    };
    const object: Record<string, unknown> = { id: media.mediaId };
    if (media.kind === "audio" && media.voice) object["voice"] = true;
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
      const detail = await res.text().catch(() => "");
      console.error(
        `[whatsapp] media_send_failed kind=${media.kind} status=${res.status} body=${detail}`,
      );
      return { ok: false, providerMessageId: null };
    }

    const body = (await res.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }> }
      | null;
    const providerMessageId = body?.messages?.[0]?.id ?? null;
    console.log(
      `[whatsapp] media_send_ok kind=${media.kind} media_id=${media.mediaId} provider_message_id=${providerMessageId ?? "none"}`,
    );
    return { ok: true, providerMessageId };
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
 * Two-step Meta send (upload then reference). Failure is never fatal: the
 * caller has already delivered the same answer as text.
 *
 * METADATA CONSISTENCY: the upload filename is derived from the real MIME of
 * the generated bytes (MiniMax returns audio/mpeg, OpenAI Direct audio/ogg).
 * Declaring ".ogg" for an MP3 payload is a metadata lie Meta can reject.
 *
 * NATIVE VOICE NOTE: Meta renders `voice: true` only for OGG/Opus. MP3 is
 * accepted but always renders as a generic audio attachment, so the flag is
 * set only when the bytes really are OGG. No transcoding happens here.
 */
export const WHATSAPP_AUDIO_FILENAMES: Record<string, string> = {
  "audio/ogg": "reply.ogg",
  "audio/mpeg": "reply.mp3",
  "audio/mp4": "reply.m4a",
  "audio/aac": "reply.aac",
  "audio/amr": "reply.amr",
};

function normalizeAudioMime(mimeType: string): string {
  return (mimeType || "").split(";")[0]!.trim().toLowerCase();
}

/** Filename that matches the actual container of the generated audio. */
export function whatsappAudioFilename(mimeType: string): string {
  return WHATSAPP_AUDIO_FILENAMES[normalizeAudioMime(mimeType)] ?? "reply.bin";
}

/** Meta renders a native voice note only for OGG/Opus payloads. */
export function supportsNativeVoiceNote(mimeType: string): boolean {
  return normalizeAudioMime(mimeType) === "audio/ogg";
}

export async function sendWhatsappAudio(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  audio: { bytes: Uint8Array; mimeType: string },
): Promise<boolean> {
  const mimeType = normalizeAudioMime(audio.mimeType) || "audio/ogg";
  const mediaId = await uploadWhatsappMedia(phoneNumberId, accessToken, {
    bytes: audio.bytes,
    mimeType,
    filename: whatsappAudioFilename(mimeType),
  });
  if (!mediaId) {
    console.error("[whatsapp] voice_upload_failed");
    return false;
  }
  const result = await sendWhatsappMediaMessage(phoneNumberId, accessToken, to, {
    kind: "audio",
    mediaId,
    ...(supportsNativeVoiceNote(mimeType) ? { voice: true } : {}),
  });
  if (!result.ok) {
    console.error("[whatsapp] voice_send_failed");
    return false;
  }
  console.log("[whatsapp] whatsapp_voice_sent ok=true");
  return true;
}

