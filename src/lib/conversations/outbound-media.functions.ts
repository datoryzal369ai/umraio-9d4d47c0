/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  MAX_OUTBOUND_BYTES,
  authorizeOutboundSend,
  filenameForOutboundMime,
  outboundMediaBody,
  validateRecordedAudioBytes,
} from "@/lib/conversations/outbound-media.core";


/**
 * B-4.4 — OUTBOUND MEDIA COMPOSER (server).
 *
 * Security order (non-negotiable):
 *   1. authenticated console user (middleware),
 *   2. conversation ownership verified through the caller's OWN RLS client,
 *   3. MIME + size revalidated server-side,
 *   4. only then is the agency WhatsApp token read server-side,
 *   5. the message row is persisted ONLY after the send has a defined result.
 *
 * The browser never receives a Meta token, a service-role key or a Graph URL.
 */

export type OutboundMediaResult = {
  messageId: string;
  deliveryStatus: "sent" | "send_failed";
  providerMessageId: string | null;
  modality: "audio" | "image" | "document";
  createdAt: string;
};

const MAX_BASE64_CHARS = Math.ceil((MAX_OUTBOUND_BYTES.document * 4) / 3) + 1024;

function decodeBase64(base64: string): Uint8Array {
  const binary =
    typeof atob === "function"
      ? atob(base64)
      : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const sendConversationMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      conversationId: string;
      mimeType: string;
      base64: string;
      filename?: string | null;
      caption?: string | null;
    }) =>
      z
        .object({
          conversationId: z.string().uuid(),
          mimeType: z.string().min(3).max(120),
          base64: z.string().min(4).max(MAX_BASE64_CHARS),
          filename: z.string().max(180).nullish(),
          caption: z.string().max(900).nullish(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }): Promise<OutboundMediaResult> => {
    const supabase = (context as any).supabase;

    // (2) ownership — RLS scopes this read to the caller's agency, so a
    // cross-tenant or cross-conversation id simply resolves to nothing.
    const { data: conversation, error } = await supabase
      .from("conversations")
      .select("id, agency_id, lead:leads(phone)")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    // (3) ownership + MIME + size revalidated server-side in one pure gate.
    const bytes = decodeBase64(data.base64);
    const auth = authorizeOutboundSend({
      conversation: conversation ?? null,
      mimeType: data.mimeType,
      byteLength: bytes.byteLength,
    });
    if (!auth.ok) throw new Error(auth.message);
    const { kind, mimeType, to } = auth;
    const audioBytes = kind === "audio" ? validateRecordedAudioBytes(mimeType, bytes) : null;
    if (audioBytes && !audioBytes.ok) throw new Error(audioBytes.message);


    // (4) credentials read only AFTER ownership is proven, and only for that agency.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: config } = await supabaseAdmin
      .from("whatsapp_configs")
      .select("access_token, phone_number_id")
      .eq("agency_id", conversation.agency_id)
      .maybeSingle();
    const accessToken = (config?.access_token as string | null) ?? null;
    const phoneNumberId = (config?.phone_number_id as string | null) ?? null;
    if (!accessToken || !phoneNumberId) {
      throw new Error("WhatsApp is not connected for this agency.");
    }

    const { uploadWhatsappMedia, sendWhatsappMediaMessage } = await import(
      "@/lib/whatsapp-send.server"
    );

    const filename = (data.filename ?? "").trim() || undefined;
    const mediaId = await uploadWhatsappMedia(phoneNumberId, accessToken, {
      bytes,
      mimeType,
      // The extension must describe the real container; a hardcoded .ogg on an
      // mp4/aac recording uploads fine and then never plays on WhatsApp.
      filename:
        kind === "audio"
          ? filenameForOutboundMime(mimeType, "voice-note")
          : (filename ?? filenameForOutboundMime(mimeType, "attachment")),
    });
    if (!mediaId) {
      // Nothing was persisted and nothing lives on Meta: a failed upload leaves
      // no server-side temporary media to clean up.
      throw new Error("This media could not be uploaded to WhatsApp. Please try again.");
    }
    console.log(
      `[whatsapp] console_media_uploaded kind=${kind} mime=${mimeType} container=${audioBytes?.ok ? audioBytes.container : "n/a"} codec=${audioBytes?.ok ? audioBytes.codec : "n/a"} media_id=${mediaId}`,
    );

    const caption = (data.caption ?? "").trim() || undefined;
    const send = await sendWhatsappMediaMessage(phoneNumberId, accessToken, to, {
      kind,
      mediaId,
      ...(caption ? { caption } : {}),
      ...(kind === "document" && filename ? { filename } : {}),
    });

    // (5) persist with the real delivery result — never a false "sent".
    const deliveryStatus = send.ok ? "sent" : "send_failed";
    console.log(
      `[whatsapp] console_media_send_result kind=${kind} ok=${send.ok} media_id=${mediaId} provider_message_id=${send.providerMessageId ?? "none"}`,
    );
    const { data: row, error: insertError } = await supabaseAdmin
      .from("messages")
      .insert({
        agency_id: conversation.agency_id,
        conversation_id: conversation.id,
        // E — a console send is a human/agent action, never labelled AI.
        sender: "human",
        body: caption ? `${outboundMediaBody(kind, filename)} ${caption}` : outboundMediaBody(kind, filename),
        modality: kind,
        media_id: mediaId,
        provider_message_id: send.providerMessageId,
        delivery_status: deliveryStatus,
      })
      .select("id, created_at")
      .single();
    if (insertError) throw new Error(insertError.message);

    await supabaseAdmin
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // H — auditability without unnecessary PII (no filename body, no phone).
    await supabaseAdmin.from("activity_log").insert({
      agency_id: conversation.agency_id,
      actor: "human",
      action: send.ok
        ? `Agent sent a ${kind} on WhatsApp`
        : `Agent ${kind} send failed on WhatsApp`,
      entity: "conversation",
      entity_id: conversation.id,
      meta: {
        modality: kind,
        mime_type: mimeType,
        byte_length: bytes.byteLength,
        delivery_status: deliveryStatus,
        provider_message_id: send.providerMessageId,
      },
    });

    if (!send.ok) {
      throw new Error("WhatsApp rejected this media. You can retry the send.");
    }

    return {
      messageId: row.id as string,
      deliveryStatus,
      providerMessageId: send.providerMessageId,
      modality: kind,
      createdAt: row.created_at as string,
    };
  });
