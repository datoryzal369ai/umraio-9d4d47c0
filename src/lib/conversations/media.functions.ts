/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isRenderableMime, mediaKindOf, normalizeMime } from "@/lib/conversations/media.core";
import { fetchWhatsappMedia } from "@/lib/whatsapp/media.server";

/**
 * B-4.3 — SECURE READ-ONLY MEDIA RESOLUTION.
 *
 * The browser never receives a Meta access token, a service-role key or the
 * temporary Graph media URL. It asks for ONE message it is already allowed to
 * see, and receives a short-lived in-memory data URL.
 *
 * Security order (non-negotiable):
 *   1. authenticated caller (middleware),
 *   2. ownership verified through the caller's OWN RLS-scoped client,
 *   3. only then is the agency WhatsApp token read server-side,
 *   4. MIME validated before the bytes are handed back.
 */

const MAX_RENDER_BYTES = 10 * 1024 * 1024;

export type ResolvedMedia = {
  kind: "audio" | "image" | "document";
  mimeType: string;
  byteLength: number;
  /** data: URL — held in memory only, never persisted, never a provider URL. */
  dataUrl: string;
};

export const resolveMessageMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { messageId: string; conversationId: string }) =>
    z
      .object({ messageId: z.string().uuid(), conversationId: z.string().uuid() })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<ResolvedMedia> => {
    // (2) ownership — RLS scopes this read to the caller's agency.
    const { data: message, error } = await (context as any).supabase
      .from("messages")
      .select("id, agency_id, conversation_id, modality, media_id")
      .eq("id", data.messageId)
      .eq("conversation_id", data.conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!message) throw new Error("Message not found in this conversation.");

    const kind = mediaKindOf(message.modality as string | null);
    if (kind !== "audio" && kind !== "image" && kind !== "document") {
      throw new Error("This message has no renderable media.");
    }
    const mediaId = (message.media_id as string | null) ?? null;
    if (!mediaId) throw new Error("This media is no longer available.");

    // (3) token read AFTER ownership is proven, and only for that agency.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: config } = await supabaseAdmin
      .from("whatsapp_configs")
      .select("access_token")
      .eq("agency_id", message.agency_id)
      .maybeSingle();
    const accessToken = (config?.access_token as string | null) ?? null;
    if (!accessToken) throw new Error("WhatsApp is not connected for this agency.");

    const defaultMimeType =
      kind === "audio" ? "audio/ogg" : kind === "image" ? "image/jpeg" : "application/pdf";

    const result = await fetchWhatsappMedia(mediaId, accessToken, {
      maxBytes: MAX_RENDER_BYTES,
      defaultMimeType,
      logPrefix: "crm-media",
    });
    if (!result.ok) {
      throw new Error(
        result.reason === "too_large" ? "This media is too large to preview." : "This media could not be loaded.",
      );
    }

    // (4) MIME allow-list before anything reaches the browser.
    const mimeType = normalizeMime(result.mimeType) || defaultMimeType;
    if (!isRenderableMime(kind, mimeType)) {
      throw new Error("This media type cannot be previewed.");
    }

    let binary = "";
    for (const byte of result.bytes) binary += String.fromCharCode(byte);
    const base64 =
      typeof btoa === "function" ? btoa(binary) : Buffer.from(result.bytes).toString("base64");

    return {
      kind,
      mimeType,
      byteLength: result.byteLength,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  });
