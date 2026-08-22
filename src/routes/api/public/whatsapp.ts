import { createFileRoute } from "@tanstack/react-router";

import { verifyMetaSignature } from "@/lib/whatsapp-signature";
import { classifyInboundMessage, persistedModality } from "@/lib/whatsapp/message-classification.core";

type WebhookValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: Array<{
    id?: string;
    from?: string;
    type?: string;
    text?: { body?: string };
    audio?: { id?: string; mime_type?: string; voice?: boolean };
    voice?: { id?: string; mime_type?: string };
  }>;
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

        // VOICE V1 PREP (1) — classify BEFORE any modality-specific work.
        const inbound = classifyInboundMessage(message);
        const from = inbound.from;
        const providerMessageId = inbound.providerMessageId;
        if (!from) return new Response("ok");

        // VOICE V1 PREP (1) — agency/config/access-token resolution is HOISTED
        // above the modality branch: audio retrieval will need the authenticated
        // Meta token before anything else. Tenant resolution semantics unchanged.
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
        // VOICE V1 PREP (2) — this gate runs BEFORE media retrieval / ASR / LLM,
        // so a replayed audio webhook can never re-download or re-transcribe.
        if (providerMessageId) {
          const { data: seen } = await supabaseAdmin
            .from("messages")
            .select("id")
            .eq("agency_id", agencyId)
            .eq("provider_message_id", providerMessageId)
            .maybeSingle();
          if (seen) {
            console.log(
              `[whatsapp] duplicate delivery ignored provider_message_id=${providerMessageId} modality=${inbound.modality}`,
            );
            return new Response("ok");
          }
        }

        // VOICE V1 — modality routing. Audio becomes a transcript here and then
        // enters the EXISTING text pipeline unchanged. There is no second brain.
        if (inbound.modality === "unsupported") {
          console.log(
            `[whatsapp] unsupported message type ignored agency_id=${agencyId} type=${inbound.rawType}`,
          );
          return new Response("ok");
        }

        let text = inbound.text;
        if (inbound.modality === "audio") {
          if (!inbound.mediaId || !config.access_token) {
            console.error(
              `[whatsapp] audio not processable agency_id=${agencyId} has_media=${Boolean(inbound.mediaId)} has_token=${Boolean(config.access_token)}`,
            );
            return new Response("ok");
          }
          const { ingestVoiceNote } = await import("@/lib/voice/inbound.server");
          const voice = await ingestVoiceNote(supabaseAdmin as never, {
            agencyId,
            mediaId: inbound.mediaId,
            accessToken: config.access_token,
            providerMessageId,
          });
          if (!voice.ok) {
            // Never silently drop, never fabricate a transcript, never let the
            // sales brain answer guessed content.
            await sendWhatsappText(
              phoneNumberId,
              config.access_token,
              from,
              voice.customerMessage,
            );
            await supabaseAdmin.from("activity_log").insert({
              agency_id: agencyId,
              actor: "ai",
              action: "Voice note could not be processed",
              entity: "lead",
              entity_id: null,
              meta: { reason: voice.reason, from },
            });
            return new Response("ok");
          }
          text = voice.transcript;
        }

        if (!text.trim()) return new Response("ok");



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
        // IDEMPOTENCY (authoritative gate): the DB unique index on
        // (agency_id, provider_message_id) makes concurrent duplicate deliveries
        // resolve to exactly one processed message. A conflict = stop, no AI, no send.
        const { error: insertError } = await supabaseAdmin.from("messages").insert({
          agency_id: agencyId,
          conversation_id: conversationId,
          sender: "customer",
          body: text,
          provider_message_id: providerMessageId,
          modality: persistedModality(inbound.modality),
          media_id: inbound.mediaId,
        });
        if (insertError) {
          if (insertError.code === "23505") {
            console.log(
              `[whatsapp] concurrent duplicate delivery ignored provider_message_id=${providerMessageId}`,
            );
            return new Response("ok");
          }
          console.error("[whatsapp] inbound message insert failed", insertError.message);
          return new Response("ok");
        }
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
          // J3 — RAPID MESSAGE COALESCING. Exactly one delivery per conversation
          // wins the claim; the others just persist their message and return, so
          // a burst of rapid messages produces ONE contextual reply, not one per
          // message. C2 idempotency above is untouched.
          const {
            claimConversationReply,
            releaseConversationClaim,
            loadPendingInbound,
            waitForCoalesceWindow,
            coalesceWindowMs,
          } = await import("@/lib/whatsapp/coalescing.server");

          // VOICE V1 — audio turns use the shorter window; text is unchanged.
          const windowMs = coalesceWindowMs(inbound.modality === "audio" ? "audio" : "text");

          const claimed = await claimConversationReply(supabaseAdmin as never, {
            agencyId,
            conversationId,
            windowMs,
          });
          if (!claimed) {
            console.log(
              `[whatsapp] message coalesced into in-flight reply conversation=${conversationId}`,
            );
            return new Response("ok");
          }

          try {
            // LATENCY — start the READ-ONLY work (module load, context, quota)
            // concurrently with the coalescing wait. Nothing here decides
            // whether to reply; the authoritative checks stay below the wait.
            const salesAiModule = import("@/lib/sales-ai.server");
            const prefetch = salesAiModule
              .then((m) => m.prefetchReplyInputs(supabaseAdmin as never, conversationId))
              .catch(() => null);

            // Brief accumulation window, then answer the whole burst at once.
            await waitForCoalesceWindow(windowMs);

            const { data: convState } = await supabaseAdmin
              .from("conversations")
              .select("ai_enabled, ai_muted_at")
              .eq("id", conversationId)
              .maybeSingle();

            // J4 — never replay messages received while the AI was muted.
            const pending = await loadPendingInbound(supabaseAdmin as never, {
              agencyId,
              conversationId,
              mutedAt: (convState as { ai_muted_at?: string | null } | null)?.ai_muted_at ?? null,
            });
            if (!convState?.ai_enabled || pending.length === 0) {
              console.log(
                `[whatsapp] no genuine pending inbound to answer conversation=${conversationId} pending=${pending.length}`,
              );
              await releaseConversationClaim(supabaseAdmin as never, { agencyId, conversationId });
              return new Response("ok");
            }
            console.log(`[whatsapp] coalesced inbound count=${pending.length}`);

            const { generateAgentReply, latestMessageStamp } = await salesAiModule;
            const prefetched = await prefetch;
            const expectedLatestMessageAt = latestMessageStamp(
              pending as ReadonlyArray<{ created_at?: string | null }>,
            );
            const warmUsable =
              Boolean(prefetched) && prefetched?.latestMessageAt === expectedLatestMessageAt;
            console.log(`[whatsapp] prefetch warm_used=${warmUsable}`);
            const reply = await generateAgentReply(supabaseAdmin as never, conversationId, {
              prefetched,
              expectedLatestMessageAt,
            });

            console.log(`[whatsapp] ai reply generated=${Boolean(reply)}`);
            if (reply) {
              const sent = await sendWhatsappText(phoneNumberId, config.access_token, from, reply);
              await supabaseAdmin.from("messages").insert({
                agency_id: agencyId,
                conversation_id: conversationId,
                sender: "ai",
                body: reply,
                modality: "text",
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
          } finally {
            await releaseConversationClaim(supabaseAdmin as never, { agencyId, conversationId });
          }
        } else {
          // J4 — the AI is muted (human takeover / auto-reply off). Stamp the
          // mute point so these messages are NEVER replayed when RAIŌ resumes.
          const { markConversationMuted } = await import("@/lib/whatsapp/coalescing.server");
          await markConversationMuted(supabaseAdmin as never, { agencyId, conversationId });
          console.log(
            `[whatsapp] auto-reply skipped ai_enabled=${aiEnabled} auto_reply=${config.auto_reply} has_token=${Boolean(config.access_token)}`,
          );
        }

        return new Response("ok");
      },
    },
  },
});
