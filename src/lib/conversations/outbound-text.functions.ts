/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  MAX_OUTBOUND_TEXT_CHARS,
  authorizeOutboundText,
} from "@/lib/conversations/outbound-text.core";

/**
 * CONSOLE OUTBOUND TEXT (server).
 *
 * Before this existed, a console text reply was only inserted into `messages`
 * and never handed to Meta, so it silently never reached the customer while
 * the row still read `delivery_status=sent`.
 *
 * Same security order as the media composer:
 *   1. authenticated console user (middleware),
 *   2. conversation ownership through the caller's OWN RLS client,
 *   3. only then the agency WhatsApp token is read server-side,
 *   4. the row is persisted with the REAL delivery result.
 */

export type OutboundTextResult = {
  messageId: string;
  deliveryStatus: "sent" | "send_failed";
  providerMessageId: string | null;
  createdAt: string;
};

export const sendConversationText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { conversationId: string; body: string }) =>
    z
      .object({
        conversationId: z.string().uuid(),
        body: z.string().min(1).max(MAX_OUTBOUND_TEXT_CHARS),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<OutboundTextResult> => {
    const supabase = (context as any).supabase;

    const { data: conversation, error } = await supabase
      .from("conversations")
      .select("id, agency_id, lead:leads(phone)")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const auth = authorizeOutboundText({
      conversation: conversation ?? null,
      body: data.body,
    });
    if (!auth.ok) throw new Error(auth.message);
    const { to, body } = auth;

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

    const { sendWhatsappTextDetailed } = await import("@/lib/whatsapp-send.server");
    const send = await sendWhatsappTextDetailed(phoneNumberId, accessToken, to, body);

    const deliveryStatus = send.ok ? "sent" : "send_failed";
    const { data: row, error: insertError } = await supabaseAdmin
      .from("messages")
      .insert({
        agency_id: conversation.agency_id,
        conversation_id: conversation.id,
        // A console send is a human/agent action, never labelled AI.
        sender: "human",
        body,
        modality: "text",
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

    await supabaseAdmin.from("activity_log").insert({
      agency_id: conversation.agency_id,
      actor: "human",
      action: send.ok ? "Agent replied on WhatsApp" : "Agent WhatsApp reply failed",
      entity: "conversation",
      entity_id: conversation.id,
      meta: {
        delivery_status: deliveryStatus,
        provider_message_id: send.providerMessageId,
      },
    });

    if (!send.ok) {
      throw new Error("WhatsApp rejected this message. You can retry the send.");
    }

    return {
      messageId: row.id as string,
      deliveryStatus,
      providerMessageId: send.providerMessageId,
      createdAt: row.created_at as string,
    };
  });
