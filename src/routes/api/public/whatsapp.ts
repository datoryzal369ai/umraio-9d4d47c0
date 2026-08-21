import { createFileRoute } from "@tanstack/react-router";

import { verifyMetaSignature } from "@/lib/whatsapp-signature";

type WebhookValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: Array<{ id?: string; from?: string; type?: string; text?: { body?: string } }>;
};

type WebhookBody = {
  entry?: Array<{ changes?: Array<{ value?: WebhookValue }> }>;
};

import { sendWhatsappText } from "@/lib/whatsapp-send.server";

export const Route = createFileRoute("/api/public/whatsapp")({
  server: {
    handlers: {
      // Meta webhook verification handshake
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        if (mode !== "subscribe" || !token) {
          return new Response("Bad request", { status: 400 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data } = await supabaseAdmin
          .from("whatsapp_configs")
          .select("id")
          .eq("verify_token", token)
          .maybeSingle();
        if (!data) return new Response("Forbidden", { status: 403 });
        return new Response(challenge, { headers: { "Content-Type": "text/plain" } });
      },

      POST: async ({ request }) => {
        // SECURITY: raw body → signature validation → parse → process.
        // Nothing below this gate may touch the database, AI, quota or Meta.
        const rawBody = await request.text();
        const signature = verifyMetaSignature(
          rawBody,
          request.headers.get("x-hub-signature-256"),
          process.env["META_APP_SECRET"],
        );
        if (!signature.valid) {
          console.error(
            `[whatsapp] webhook_signature_valid=false reason=${signature.reason} request_processing=rejected`,
          );
          return new Response("Unauthorized", { status: 401 });
        }
        console.log("[whatsapp] webhook_signature_valid=true");

        let payload: WebhookBody;
        try {
          payload = JSON.parse(rawBody) as WebhookBody;
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const value = payload.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];
        const phoneNumberId = value?.metadata?.phone_number_id?.trim();
        console.log(
          `[whatsapp] webhook received phone_number_id=${phoneNumberId ?? "none"} type=${message?.type ?? "none"} messages=${value?.messages?.length ?? 0}`,
        );
        if (!message || !phoneNumberId) return new Response("ok");

        const from = message.from ?? "";
        const text = message.type === "text" ? (message.text?.body ?? "") : "";
        const providerMessageId = message.id?.trim() || null;
        if (!from || !text) return new Response("ok");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: config } = await supabaseAdmin
          .from("whatsapp_configs")
          .select("id, agency_id, access_token, auto_reply")
          .eq("phone_number_id", phoneNumberId)
          .maybeSingle();
        if (!config) {
          // Return 200 so Meta does not disable/retry-storm the subscription.
          console.error(
            `[whatsapp] no agency connection matches phone_number_id=${phoneNumberId} — check Settings → WhatsApp`,
          );
          return new Response("ok");
        }
        console.log(`[whatsapp] agency identified agency_id=${config.agency_id}`);

        const agencyId = config.agency_id;
        const profileName = value?.contacts?.[0]?.profile?.name ?? from;

        // IDEMPOTENCY (fast path): Meta retries the same messages[].id. Scoped by
        // agency so identical ids across tenants stay isolated.
        if (providerMessageId) {
          const { data: seen } = await supabaseAdmin
            .from("messages")
            .select("id")
            .eq("agency_id", agencyId)
            .eq("provider_message_id", providerMessageId)
            .maybeSingle();
          if (seen) {
            console.log(
              `[whatsapp] duplicate delivery ignored provider_message_id=${providerMessageId}`,
            );
            return new Response("ok");
          }
        }

        // Find or create the lead by phone
        let leadId: string | null = null;
        const { data: lead } = await supabaseAdmin
          .from("leads")
          .select("id")
          .eq("agency_id", agencyId)
          .eq("phone", from)
          .maybeSingle();
        if (lead) {
          leadId = lead.id;
          await supabaseAdmin
            .from("leads")
            .update({ last_contact_at: new Date().toISOString() })
            .eq("id", leadId);
        } else {
          const { computeLeadScore, temperatureForScore } = await import("@/lib/sales-ai.server");
          const score = computeLeadScore({ full_name: profileName, phone: from });
          const { data: created } = await supabaseAdmin
            .from("leads")
            .insert({
              agency_id: agencyId,
              full_name: profileName,
              phone: from,
              source: "whatsapp",
              score,
              temperature: temperatureForScore(score),
              last_contact_at: new Date().toISOString(),
            })
            .select("id")
            .single();
          leadId = created?.id ?? null;
          if (leadId) {
            await supabaseAdmin.from("activity_log").insert({
              agency_id: agencyId,
              actor: "ai",
              action: "Created CRM lead from WhatsApp enquiry",
              entity: "lead",
              entity_id: leadId,
              meta: { phone: from, source: "whatsapp", score },
            });
          }
        }

        // Find or create the conversation
        let conversationId: string | null = null;
        let aiEnabled = true;
        const { data: conversation } = await supabaseAdmin
          .from("conversations")
          .select("id, ai_enabled")
          .eq("agency_id", agencyId)
          .eq("external_id", from)
          .maybeSingle();
        if (conversation) {
          conversationId = conversation.id;
          aiEnabled = conversation.ai_enabled;
          await supabaseAdmin
            .from("conversations")
            .update({ last_message_at: new Date().toISOString(), status: "open" })
            .eq("id", conversationId);
        } else {
          const { data: created } = await supabaseAdmin
            .from("conversations")
            .insert({
              agency_id: agencyId,
              lead_id: leadId,
              channel: "whatsapp",
              external_id: from,
            })
            .select("id, ai_enabled")
            .single();
          conversationId = created?.id ?? null;
          aiEnabled = created?.ai_enabled ?? true;
        }
        if (!conversationId) return new Response("ok");

        const inboundAt = new Date();
        await supabaseAdmin.from("messages").insert({
          agency_id: agencyId,
          conversation_id: conversationId,
          sender: "customer",
          body: text,
        });
        await supabaseAdmin
          .from("whatsapp_configs")
          .update({ last_inbound_at: inboundAt.toISOString() })
          .eq("id", config.id);
        await supabaseAdmin.from("activity_log").insert({
          agency_id: agencyId,
          actor: "customer",
          action: "Inbound WhatsApp message received",
          entity: "conversation",
          entity_id: conversationId,
          meta: { from, preview: text.slice(0, 160) },
        });

        if (aiEnabled && config.auto_reply && config.access_token) {
          try {
            const { generateAgentReply } = await import("@/lib/sales-ai.server");
            const reply = await generateAgentReply(supabaseAdmin as never, conversationId);
            console.log(`[whatsapp] ai reply generated=${Boolean(reply)}`);
            if (reply) {
              const sent = await sendWhatsappText(phoneNumberId, config.access_token, from, reply);
              await supabaseAdmin.from("messages").insert({
                agency_id: agencyId,
                conversation_id: conversationId,
                sender: "ai",
                body: reply,
              });
              const responseMs = Date.now() - inboundAt.getTime();
              await supabaseAdmin
                .from("conversations")
                .update({
                  last_message_at: new Date().toISOString(),
                  first_response_ms: responseMs,
                })
                .eq("id", conversationId);
              await supabaseAdmin.from("activity_log").insert({
                agency_id: agencyId,
                actor: "ai",
                action: "AI WhatsApp Executive replied to customer",
                entity: "conversation",
                entity_id: conversationId,
                meta: { response_ms: responseMs, delivered: sent, preview: reply.slice(0, 160) },
              });

              // A quotation is only "sent" once the message actually left.
              if (sent) {
                const now = new Date().toISOString();
                const { data: issued } = await supabaseAdmin
                  .from("quotations")
                  .update({ status: "sent", sent_at: now })
                  .eq("conversation_id", conversationId)
                  .eq("status", "ready")
                  .select("id, lead_id");
                for (const q of issued ?? []) {
                  await supabaseAdmin.from("conversion_events").insert({
                    agency_id: agencyId,
                    stage: "quotation_sent",
                    actor: "ai",
                    lead_id: q.lead_id,
                    quotation_id: q.id,
                  });
                }
              }
            }
          } catch (error) {
            console.error("[whatsapp] AI reply failed", error);
          }
        } else {
          console.log(
            `[whatsapp] auto-reply skipped ai_enabled=${aiEnabled} auto_reply=${config.auto_reply} has_token=${Boolean(config.access_token)}`,
          );
        }

        return new Response("ok");
      },
    },
  },
});
