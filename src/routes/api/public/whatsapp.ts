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
    image?: { id?: string; mime_type?: string; caption?: string };
    document?: {
      id?: string;
      filename?: string;
      mime_type?: string;
      file_size?: number;
      caption?: string;
    };
  }>;

};

type WebhookBody = {
  entry?: Array<{ changes?: Array<{ value?: WebhookValue }> }>;
};

import { sendWhatsappText } from "@/lib/whatsapp-send.server";

/** P0-1 — defensive cap on how many inbound messages one delivery may process. */
const MAX_MESSAGES_PER_REQUEST = 10;

type InboundMessage = NonNullable<WebhookValue["messages"]>[number];

/**
 * P1-5 — minimal find-or-create used ONLY to give an unsupported/document
 * inbound turn a thread to live in. It never changes AI state, DNC state or
 * conversation state; those decisions belong to the normal pipeline.
 */
async function ensureConversationForPersist(
  db: { from: (table: string) => any },
  args: { agencyId: string; from: string; profileName: string },
): Promise<string | null> {
  const { agencyId, from } = args;
  const { data: existing } = await db
    .from("conversations")
    .select("id")
    .eq("agency_id", agencyId)
    .eq("external_id", from)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: lead } = await db
    .from("leads")
    .select("id")
    .eq("agency_id", agencyId)
    .eq("phone", from)
    .maybeSingle();

  const { data: created } = await db
    .from("conversations")
    .insert({
      agency_id: agencyId,
      lead_id: lead?.id ?? null,
      channel: "whatsapp",
      external_id: from,
    })
    .select("id")
    .single();
  if (created?.id) return created.id as string;

  const { data: raced } = await db
    .from("conversations")
    .select("id")
    .eq("agency_id", agencyId)
    .eq("external_id", from)
    .maybeSingle();
  return (raced?.id as string | undefined) ?? null;
}

/**
 * Per-message processing. Business logic is unchanged; it is now callable once
 * per message in a batched Meta delivery.
 *
 * Returns "retry" only for unexpected infrastructure failures, so Meta
 * redelivers instead of the turn being lost.
 */
async function processInboundMessage(
  value: WebhookValue,
  message: InboundMessage,
  phoneNumberId: string,
): Promise<"ok" | "retry"> {
        // VOICE V1 PREP (1) — classify BEFORE any modality-specific work.
        // Sender resolution: `messages[0].from`, else `contacts[0].wa_id` from
        // the same webhook value (Meta omits `from` for newer LID-style sender
        // identities). Whatever resolves flows through the EXISTING pipeline.
        const contact = value?.contacts?.[0];
        const inbound = classifyInboundMessage(message, { contactWaId: contact?.wa_id ?? null });
        const from = inbound.from;
        const providerMessageId = inbound.providerMessageId;
        if (!from) {
          console.log(
            `[whatsapp] inbound_dropped reason=missing_sender phone_number_id=${phoneNumberId} provider_message_id=${providerMessageId ?? "none"} message_type=${message.type ?? "none"} from_present=false contact_present=${Boolean(contact)} contact_keys=${contact ? Object.keys(contact).join("|") : "none"} message_keys=${Object.keys(message).join("|")}`,
          );
          return "ok";
        }
        console.log(`[whatsapp] sender resolved source=${inbound.senderSource}`);


        // VOICE V1 PREP (1) — agency/config/access-token resolution is HOISTED
        // above the modality branch: audio retrieval will need the authenticated
        // Meta token before anything else. Tenant resolution semantics unchanged.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        let config: { id: string; agency_id: string; access_token: string | null; auto_reply: boolean } | null = null;
        try {
          const { data, error } = await supabaseAdmin
            .from("whatsapp_configs")
            .select("id, agency_id, access_token, auto_reply")
            .eq("phone_number_id", phoneNumberId)
            .maybeSingle();
          if (error) throw error;
          config = data ?? null;
        } catch (err) {
          // P1-1 — an unexpected database failure must stay retryable so Meta
          // redelivers instead of the message being silently lost.
          console.error(
            `[whatsapp] conversation_terminal_outcome=config_lookup_failed phone_number_id=${phoneNumberId} error=${err instanceof Error ? err.message : String(err)}`,
          );
          return "retry";
        }
        if (!config) {
          // Return 200 so Meta does not disable/retry-storm the subscription.
          console.error(
            `[whatsapp] no agency connection matches phone_number_id=${phoneNumberId} — check Settings → WhatsApp`,
          );
          return "ok";
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
            return "ok";
          }
        }

        // VOICE V1 — modality routing. Audio becomes a transcript here and then
        // enters the EXISTING text pipeline unchanged. There is no second brain.
        // DOCUMENT V1 (STEP 1) — classification only. Documents are recognised
        // and logged, but nothing is retrieved or processed yet.
        if (inbound.modality === "document" || inbound.modality === "unsupported") {
          // P1-5 — the transcript must never have a hole. The inbound turn is
          // persisted for its modality (no invented text, idempotency kept) and
          // no AI reply is produced for content the pipeline cannot read.
          console.log(
            inbound.modality === "document"
              ? `[whatsapp] document classified agency_id=${agencyId} has_media=${Boolean(inbound.mediaId)} has_filename=${Boolean(inbound.filename)} mime=${inbound.mimeType ?? "none"} size=${inbound.fileSize ?? "unknown"} processing=deferred`
              : `[whatsapp] unsupported message type ignored agency_id=${agencyId} type=${inbound.rawType}`,
          );
          const placeholderConversationId = await ensureConversationForPersist(supabaseAdmin, {
            agencyId,
            from,
            profileName,
          });
          if (!placeholderConversationId) {
            console.log(
              `[whatsapp] conversation_terminal_outcome=unsupported_persist_no_conversation modality=${inbound.modality}`,
            );
            return "ok";
          }
          const { error: unsupportedInsertError } = await supabaseAdmin.from("messages").insert({
            agency_id: agencyId,
            conversation_id: placeholderConversationId,
            sender: "customer",
            body: "",
            provider_message_id: providerMessageId,
            modality: "text",
            media_id: inbound.mediaId ?? null,
          });
          if (unsupportedInsertError && unsupportedInsertError.code !== "23505") {
            console.error(
              `[whatsapp] conversation_terminal_outcome=unsupported_persist_failed modality=${inbound.modality} reason=${unsupportedInsertError.code ?? "unknown"}`,
            );
          } else {
            console.log(
              `[whatsapp] conversation_terminal_outcome=unsupported_persisted modality=${inbound.modality}`,
            );
          }
          return "ok";
        }

        let text = inbound.text;
        if (inbound.modality === "audio") {
          if (!inbound.mediaId || !config.access_token) {
            console.error(
              `[whatsapp] audio not processable agency_id=${agencyId} has_media=${Boolean(inbound.mediaId)} has_token=${Boolean(config.access_token)}`,
            );
            return "ok";
          }
          const { ingestVoiceNote } = await import("@/lib/voice/inbound.server");
          // voice_language is the agency's dedicated spoken language; it steers
          // transcription too so Malaysian Malay is never heard as Indonesian.
          const { data: inboundVoiceSettings } = await supabaseAdmin
            .from("agency_settings")
            .select("voice_language")
            .eq("agency_id", agencyId)
            .maybeSingle();
          const voice = await ingestVoiceNote(supabaseAdmin as never, {
            agencyId,
            mediaId: inbound.mediaId,
            accessToken: config.access_token,
            providerMessageId,
            voiceLanguage: (inboundVoiceSettings?.voice_language as string | null) ?? null,
          });
          if (!voice.ok) {
            // Never silently drop, never fabricate a transcript, never let the
            // sales brain answer guessed content. Voice notes are supported —
            // the customer is told what went wrong with THIS recording only.
            //
            // Repetition guard: back-to-back failures of the same kind within a
            // short window must not spam the customer with identical replies.
            const dedupeSince = new Date(Date.now() - 120_000).toISOString();
            const { data: recentFallback } = await supabaseAdmin
              .from("activity_log")
              .select("id, meta, created_at")
              .eq("agency_id", agencyId)
              .eq("action", "Voice note could not be processed")
              .gte("created_at", dedupeSince)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            const recentMeta = (recentFallback?.meta ?? null) as
              | { reason?: string; from?: string }
              | null;
            const isDuplicateFallback =
              Boolean(recentFallback) &&
              recentMeta?.from === from &&
              recentMeta?.reason === voice.reason;
            if (isDuplicateFallback) {
              console.log(
                `[voice] fallback_suppressed reason=${voice.reason} agency_id=${agencyId} window_s=120`,
              );
            } else {
              await sendWhatsappText(
                phoneNumberId,
                config.access_token,
                from,
                voice.customerMessage,
              );
            }
            await supabaseAdmin.from("activity_log").insert({
              agency_id: agencyId,
              actor: "ai",
              action: "Voice note could not be processed",
              entity: "lead",
              entity_id: null,
              meta: { reason: voice.reason, from },
            });
            return "ok";
          }
          text = voice.transcript;
        }

        // IMAGE V1 — the image becomes a grounded text observation here and
        // then enters the EXISTING text pipeline unchanged. No second brain,
        // no fabricated contents, no raw bytes persisted.
        if (inbound.modality === "image") {
          if (!inbound.mediaId || !config.access_token) {
            console.error(
              `[whatsapp] image not processable agency_id=${agencyId} has_media=${Boolean(inbound.mediaId)} has_token=${Boolean(config.access_token)}`,
            );
            return "ok";
          }
          const { ingestInboundImage } = await import("@/lib/vision/inbound.server");
          const vision = await ingestInboundImage(supabaseAdmin as never, {
            agencyId,
            mediaId: inbound.mediaId,
            accessToken: config.access_token,
            providerMessageId,
            caption: inbound.caption,
          });
          if (!vision.ok) {
            // Never fabricate image contents — ask honestly for a clearer image.
            await sendWhatsappText(phoneNumberId, config.access_token, from, vision.customerMessage);
            await supabaseAdmin.from("activity_log").insert({
              agency_id: agencyId,
              actor: "ai",
              action: "Image could not be processed",
              entity: "lead",
              entity_id: null,
              meta: { reason: vision.reason, from },
            });
            return "ok";
          }
          text = vision.text;
        }

        if (!text.trim()) {
          console.log(
            `[whatsapp] conversation_terminal_outcome=no_usable_text modality=${inbound.modality} agency_id=${agencyId}`,
          );
          return "ok";
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
          const { data: created, error: leadInsertError } = await supabaseAdmin
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
          // P0-2 — a concurrent delivery may have created the same lead first.
          // The unique index turns that race into 23505; re-select the winner
          // instead of creating a duplicate CRM record.
          let leadWasCreated = Boolean(leadId);
          if (!leadId && leadInsertError) {
            const { data: existing } = await supabaseAdmin
              .from("leads")
              .select("id")
              .eq("agency_id", agencyId)
              .eq("phone", from)
              .maybeSingle();
            leadId = existing?.id ?? null;
            if (leadId) {
              console.log(`[whatsapp] lead_create_race_resolved agency_id=${agencyId}`);
            }
          }
          if (leadId && leadWasCreated) {
            const { recordLeadCreated } = await import("@/lib/conversion/producers");
            await recordLeadCreated({
              db: supabaseAdmin,
              agencyId,
              leadId,
              actor: "customer",
              source: "whatsapp",
            });
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
          .select("id, ai_enabled, conversation_state")
          .eq("agency_id", agencyId)
          .eq("external_id", from)
          .maybeSingle();
        if (conversation) {
          conversationId = conversation.id;
          aiEnabled = conversation.ai_enabled;
          let convUpdate: {
            last_message_at: string;
            status: string;
            ai_enabled?: boolean;
            conversation_state?: string;
            state_updated_at?: string;
          } = {
            last_message_at: new Date().toISOString(),
            status: "open",
          };
          // CURRENT-TURN DNC RULE: a conversation muted by a PAST opt-out is
          // re-opened when the customer themselves starts a new turn that is
          // not itself a STOP request. A current-turn STOP is handled by the
          // deterministic safety gate, which re-applies do-not-contact.
          if (conversation.conversation_state === "DO_NOT_CONTACT") {
            const { detectOptOut } = await import("@/lib/sales/hardening.core");
            if (!detectOptOut(text).optedOut) {
              convUpdate = {
                ...convUpdate,
                ai_enabled: true,
                conversation_state: "ACTIVE",
                state_updated_at: new Date().toISOString(),
              };
              aiEnabled = true;
              console.log(
                `[whatsapp] dnc_reengaged conversation=${conversationId} reason=customer_initiated_inbound`,
              );
            }
          }
          await supabaseAdmin
            .from("conversations")
            .update(convUpdate)
            .eq("id", conversationId);
        } else {

          const { data: created, error: conversationInsertError } = await supabaseAdmin
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
          // P0-2 — same race protection for the conversation thread.
          if (!conversationId && conversationInsertError) {
            const { data: existingConversation } = await supabaseAdmin
              .from("conversations")
              .select("id, ai_enabled")
              .eq("agency_id", agencyId)
              .eq("external_id", from)
              .maybeSingle();
            conversationId = existingConversation?.id ?? null;
            aiEnabled = existingConversation?.ai_enabled ?? true;
            if (conversationId) {
              console.log(`[whatsapp] conversation_create_race_resolved agency_id=${agencyId}`);
            }
          }
        }
        if (!conversationId) {
          console.log(
            `[whatsapp] conversation_terminal_outcome=conversation_unavailable agency_id=${agencyId} modality=${inbound.modality}`,
          );
          return "ok";
        }

        const inboundAt = new Date();
        if (inbound.modality === "audio") {
          console.log(
            `[voice] VOICE_INBOUND_START conversation_id=${conversationId} message_id=${providerMessageId ?? "none"} inbound_at=${inboundAt.toISOString()} transcript=${JSON.stringify(text)}`,
          );
        }
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
            return "ok";
          }
          console.error(
            `[whatsapp] conversation_terminal_outcome=inbound_insert_failed modality=${inbound.modality} reason=${insertError.code ?? "unknown"}`,
          );
          return "ok";
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
            return "ok";
          }
          console.log(`[whatsapp] inbound_claimed modality=${inbound.modality}`);


          try {
            // UX — show the customer a typing/processing state immediately so
            // the wait never feels like silence. Best effort, never fatal.
            if (providerMessageId) {
              const { sendWhatsappTypingIndicator } = await import("@/lib/whatsapp-send.server");
              void sendWhatsappTypingIndicator(
                phoneNumberId,
                config.access_token,
                providerMessageId,
              );
            }
            // LATENCY — start the READ-ONLY work (module load, context, quota)
            // concurrently with the coalescing wait. Nothing here decides
            // whether to reply; the authoritative checks stay below the wait.
            const salesAiModule = import("@/lib/sales-ai.server");

            const prefetch = salesAiModule
              .then((m) =>
                typeof m.prefetchReplyInputs === "function"
                  ? m.prefetchReplyInputs(supabaseAdmin as never, conversationId)
                  : null,
              )
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
                `[whatsapp] conversation_terminal_outcome=${!convState?.ai_enabled ? "no_reply_ai_disabled" : "no_reply_empty_pending"} conversation=${conversationId} pending=${pending.length}`,
              );

              await releaseConversationClaim(supabaseAdmin as never, { agencyId, conversationId });
              return "ok";
            }
            console.log(`[whatsapp] coalesced inbound count=${pending.length}`);

            const { generateAgentReply } = await salesAiModule;

            const prefetched = await prefetch;
            let expectedLatestMessageAt: string | null = null;
            for (const m of pending as ReadonlyArray<{ created_at?: string | null }>) {
              const at = m.created_at ?? null;
              if (at && (!expectedLatestMessageAt || at > expectedLatestMessageAt)) {
                expectedLatestMessageAt = at;
              }
            }

            const warmUsable =
              Boolean(prefetched) && prefetched?.latestMessageAt === expectedLatestMessageAt;
            console.log(`[whatsapp] prefetch warm_used=${warmUsable}`);
            const reply = await generateAgentReply(supabaseAdmin as never, conversationId, {
              prefetched,
              expectedLatestMessageAt,
            });

            console.log(`[whatsapp] ai reply generated=${Boolean(reply)}`);
            if (reply) {
              // HUMANISED TIMING — only ever pads a reply that arrived faster
              // than a human executive plausibly could. Never slows a real one.
              const { presentationDelayMs, latencyBucketLabel } = await import(
                "@/lib/sales/context-continuity.core"
              );
              const elapsedMs = Date.now() - inboundAt.getTime();
              const pad = presentationDelayMs({
                elapsedMs,
                modality: inbound.modality === "image" || inbound.modality === "audio"
                  ? inbound.modality
                  : "text",
                replyLength: reply.length,
              });
              if (pad > 0) await new Promise((r) => setTimeout(r, pad));
              console.log(
                `[whatsapp] response_latency_bucket=${latencyBucketLabel(elapsedMs + pad)} presentation_delay_ms=${pad} modality=${inbound.modality}`,
              );
              // RELIABILITY CONTRACT — TEXT FIRST, ALWAYS.
              // Nothing in the voice/presentation layer may run before the
              // text answer has been sent AND persisted.
              console.log("[whatsapp] text_send_started");
              const sent = await sendWhatsappText(phoneNumberId, config.access_token, from, reply);
              console.log(`[whatsapp] ${sent ? "text_send_succeeded" : "text_send_failed"}`);

              // B-3.2 — AI_GENERATED is NOT the same as WHATSAPP_SENT. A failed
              // Meta send is persisted as `send_failed` so no part of the system
              // (CRM, analytics, follow-ups) can read it as a delivered reply.
              await supabaseAdmin.from("messages").insert({
                agency_id: agencyId,
                conversation_id: conversationId,
                sender: "ai",
                body: reply,
                modality: "text",
                delivery_status: sent ? "sent" : "send_failed",
              });
              const responseMs = Date.now() - inboundAt.getTime();
              await supabaseAdmin
                .from("conversations")
                .update({
                  last_message_at: new Date().toISOString(),
                  ...(sent ? { first_response_ms: responseMs } : {}),
                })
                .eq("id", conversationId);
              await supabaseAdmin.from("activity_log").insert({
                agency_id: agencyId,
                actor: "ai",
                action: sent
                  ? "AI WhatsApp Executive replied to customer"
                  : "AI WhatsApp Executive reply could not be delivered",
                entity: "conversation",
                entity_id: conversationId,
                meta: { response_ms: responseMs, delivered: sent, preview: reply.slice(0, 160) },
              });
              console.log(
                `[whatsapp] conversation_terminal_outcome=${sent ? "replied_text_only" : "no_reply_send_failed"} delivered=${sent} latency_bucket=${latencyBucketLabel(responseMs)}`,
              );


              // VOICE REPLY V1 — strictly best-effort, strictly AFTER the text
              // answer is delivered and persisted. Any failure here leaves a
              // complete text-only answer and never blocks the turn.
              if (sent && inbound.modality === "audio") {
                const vlog = (stage: string, extra = "") =>
                  console.log(`[voice] ${stage} conversation_id=${conversationId}${extra ? ` ${extra}` : ""}`);
                vlog("VOICE_OUTBOUND_START");
                try {
                  const { decideVoiceReply, isDeliverableAudio } = await import(
                    "@/lib/voice/tts.core"
                  );
                  // VOICE NATURALNESS V2 — persona comes from the agency's
                  // voice console; an approved Islamic answer is spoken
                  // verbatim and a PENDING review is never spoken at all.
                  const { data: voiceSettings } = await supabaseAdmin
                    .from("agency_settings")
                    .select("voice_persona, voice_controls, voice_name, voice_language")
                    .eq("agency_id", agencyId)
                    .maybeSingle();
                  // V2.3 — use the same authoritative current-turn lookup as
                  // the early loop breaker. Previous-turn reviews stay in the
                  // review queue without muting this unrelated voice turn.
                  const { findCurrentTurnOpenReview } = await import(
                    "@/lib/islamic/review.server"
                  );
                  const openIslamic = await findCurrentTurnOpenReview(
                    supabaseAdmin as never,
                    conversationId,
                    inboundAt,
                     text,
                     "voice_eligibility",
                  );
                  const voiceLanguage =
                    (voiceSettings?.voice_language as string | undefined) ?? "ms-MY";
                  const decision = decideVoiceReply({
                    inboundModality: inbound.modality,
                    replyText: reply,
                    persona: {
                      persona: voiceSettings?.voice_persona ?? null,
                      controls: (voiceSettings?.voice_controls ?? {}) as Record<string, unknown>,
                      voice: voiceSettings?.voice_name ?? null,
                    },
                    language: voiceLanguage,
                    islamicReviewPending: Boolean(openIslamic),
                  });
                  vlog(
                    "VOICE_ELIGIBILITY",
                    `speak=${decision.speak} reason=${decision.speak ? "eligible" : decision.reason} islamic_turn_review=${Boolean(openIslamic)} voice_language=${voiceLanguage} reply_chars=${reply.length}`,
                  );
                  vlog(
                    "VOICE_ELIGIBILITY_REASON",
                    `reason=${decision.speak ? "eligible" : decision.reason} islamic_turn_review=${Boolean(openIslamic)}`,
                  );
                  if (!decision.speak) {
                    console.log(`[voice] voice_reply_fallback_text reason=${decision.reason}`);
                  } else {
                    const ttsStarted = Date.now();
                    const { synthesizeSpeech } = await import("@/lib/voice/tts.server");
                    vlog(
                      "VOICE_TTS_START",
                      `persona=${decision.presentation.personaKey} voice_name=${decision.presentation.voice} speed=${decision.presentation.speed} length_class=${decision.presentation.lengthClass} spoken_chars=${decision.text.length}`,
                    );
                    const speech = await synthesizeSpeech({
                      text: decision.text,
                      voice: decision.presentation.voice,
                      speed: decision.presentation.speed,
                      instructions: decision.presentation.instructions,
                    });
                    if (!speech.ok || !isDeliverableAudio({ byteLength: speech.bytes.byteLength })) {
                      vlog(
                        "VOICE_TTS_FAILURE",
                        `reason=${speech.ok ? "audio_too_large" : speech.kind}`,
                      );
                      console.log(
                        `[voice] tts_failed reason=${speech.ok ? "audio_too_large" : speech.kind}`,
                      );
                    } else {
                      vlog(
                        "VOICE_TTS_SUCCESS",
                        `VOICE_PROVIDER=${speech.engine} VOICE_AUDIO_FORMAT=${speech.mimeType} VOICE_AUDIO_BYTES=${speech.bytes.byteLength} VOICE_PROVIDER_LATENCY=${Date.now() - ttsStarted} engine=${speech.engine} audio_bytes=${speech.bytes.byteLength} mime_type=${speech.mimeType} latency_ms=${Date.now() - ttsStarted}`,
                      );
                      vlog("VOICE_SEND_START");
                      const { sendWhatsappAudio } = await import("@/lib/whatsapp-send.server");
                      const voiceSent = await sendWhatsappAudio(
                        phoneNumberId,
                        config.access_token,
                        from,
                        { bytes: speech.bytes, mimeType: speech.mimeType },
                      );
                      vlog(
                        voiceSent ? "VOICE_SEND_SUCCESS" : "VOICE_SEND_FAILURE",
                        `voice_reply_latency_bucket=${latencyBucketLabel(Date.now() - ttsStarted)}`,
                      );
                      console.log(
                        `[voice] ${voiceSent ? "audio_send_succeeded" : "audio_send_failed"} voice_reply_latency_bucket=${latencyBucketLabel(Date.now() - ttsStarted)}`,
                      );
                    }
                  }
                } catch (error) {
                  vlog(
                    "VOICE_TTS_FAILURE",
                    `reason=${error instanceof Error ? error.name : "unknown"}`,
                  );
                  console.error(
                    `[voice] tts_failed reason=${error instanceof Error ? error.name : "unknown"} fallback=text_only`,
                  );
                } finally {
                  vlog("VOICE_OUTBOUND_COMPLETE");
                }
              }



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
            } else {
              // No silent failures: an empty generation is an explicit,
              // observable terminal outcome.
              console.log(
                `[whatsapp] conversation_terminal_outcome=no_reply_generated failure_stage=ai_generation modality=${inbound.modality}`,
              );
            }
          } catch (error) {
            console.error(
              `[whatsapp] conversation_terminal_outcome=error failure_stage=reply_pipeline reason=${error instanceof Error ? error.name : "unknown"}`,
              error,
            );
          } finally {
            await releaseConversationClaim(supabaseAdmin as never, { agencyId, conversationId });
          }

        } else {
          // J4 — the AI is muted (human takeover / auto-reply off). Stamp the
          // mute point so these messages are NEVER replayed when RAIŌ resumes.
          const { markConversationMuted } = await import("@/lib/whatsapp/coalescing.server");
          await markConversationMuted(supabaseAdmin as never, { agencyId, conversationId });
          console.log(
            `[whatsapp] conversation_terminal_outcome=${aiEnabled ? "no_reply_ai_disabled" : "muted_human_handoff"} ai_enabled=${aiEnabled} auto_reply=${config.auto_reply} has_token=${Boolean(config.access_token)}`,
          );

        }

  return "ok";
}

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

        // P0-1 — one delivery may carry several entries/changes/messages. All
        // of them are processed (capped), never just the first.
        const queued: Array<{ value: WebhookValue; message: InboundMessage }> = [];
        let candidates = 0;
        for (const entry of payload.entry ?? []) {
          for (const change of entry.changes ?? []) {
            const changeValue = change?.value;
            if (!changeValue) continue;
            for (const msg of changeValue.messages ?? []) {
              candidates += 1;
              if (queued.length < MAX_MESSAGES_PER_REQUEST) {
                queued.push({ value: changeValue, message: msg });
              }
            }
          }
        }
        if (candidates > MAX_MESSAGES_PER_REQUEST) {
          console.log(
            `[whatsapp] webhook_batch_cap_reached cap=${MAX_MESSAGES_PER_REQUEST} received=${candidates}`,
          );
        }
        console.log(
          `[whatsapp] webhook received batch_size=${queued.length} messages=${candidates}`,
        );
        if (queued.length === 0) {
          console.log("[whatsapp] inbound_dropped reason=missing_message_or_phone_id messages_count=0");
          return new Response("ok");
        }

        let retryable = false;
        for (const item of queued) {
          const itemPhoneNumberId = item.value.metadata?.phone_number_id?.trim();
          if (!itemPhoneNumberId) {
            console.log(
              `[whatsapp] inbound_dropped reason=missing_message_or_phone_id message_type=${item.message.type ?? "none"}`,
            );
            continue;
          }
          try {
            const outcome = await processInboundMessage(item.value, item.message, itemPhoneNumberId);
            if (outcome === "retry") retryable = true;
          } catch (error) {
            console.error(
              `[whatsapp] conversation_terminal_outcome=error failure_stage=inbound_processing reason=${error instanceof Error ? error.name : "unknown"}`,
            );
            retryable = true;
          }
        }

        if (retryable) {
          // P1-1 — no internal detail in the response body.
          return new Response("Temporary processing failure", { status: 500 });
        }
        return new Response("ok");
      },
    },
  },
});
