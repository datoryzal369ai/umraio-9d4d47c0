/** Explicit Calling request adapter to the existing governed action/WhatsApp path. */
import { z } from "zod";
import { createToolRegistry, type ToolExecutionContext } from "@/lib/ai/tool-registry.server";
import { authorizeOutboundText } from "@/lib/conversations/outbound-text.core";
import { renderQuotationMessage } from "@/lib/quotations/quotations.server";
import { sendWhatsappTextDetailed, type WhatsappSendControl, type WhatsappSendOutcome, type WhatsappSendResult } from "@/lib/whatsapp-send.server";
import { requestsQuotationSend } from "./call-executive.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from: (table: string) => any };
export const CALL_QUOTATION_TOOL = "deliver_existing_quotation_whatsapp";
export type QuotationReceipt = { messageId: string; providerMessageId: string; quotationId: string };
export type CallingQuotationResult = { ok: true; receipt: QuotationReceipt } | { ok: false; reason: string;
  outcome?: WhatsappSendOutcome; dispatched?: boolean; providerEvidence?: { providerMessageId: string; quotationId: string } };

function phone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("0") ? `60${digits.slice(1)}` : digits;
}

// A primary-key claim prevents concurrent retries from sending twice. This is
// an action id, never a hash/fingerprint of a credential or customer content.
async function actionId(agencyId: string, callId: string, sequence: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`calling-quotation:${agencyId}:${callId}:${sequence}`)));
  digest[6] = (digest[6]! & 15) | 80;
  digest[8] = (digest[8]! & 63) | 128;
  const hex = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function deliverCallingQuotation(args: {
  db: Db; agencyId: string; callId: string; sequence: number; transcript: string;
  leadId: string | null; conversationId: string | null; quotationId: string | null;
  signal?: AbortSignal | undefined;
  /** Optional bounded execution owner; independent of assistant/barge-in cancellation after dispatch. */
  execution?: WhatsappSendControl & { beforeDispatch?: () => Promise<void> };
}): Promise<CallingQuotationResult> {
  if (!requestsQuotationSend(args.transcript)) return { ok: false, reason: "explicit_request_required" };
  const { db } = args;
  let prepared: { to: string; body: string; config: any } | null = null;
  let controlledResult: CallingQuotationResult | undefined;
  let observedSend: WhatsappSendResult | undefined;
  let dispatchStarted = false;
  const registry = createToolRegistry([{
    name: CALL_QUOTATION_TOOL,
    description: "Deliver only this caller's already-issued quotation to their existing WhatsApp conversation.",
    inputSchema: z.object({ quotationId: z.string().min(1), conversationId: z.string().min(1), leadId: z.string().min(1) }),
    permission: "external", deterministicSafe: true,
    // Redelivery of an unchanged issued document; no creation, pricing,
    // transaction, recipient substitution or quotation status transition.
    validate: async input => {
      if (args.signal?.aborted) return "call_cancelled";
      const [session, lead, conversation, quotation, agency] = await Promise.all([
        db.from("whatsapp_call_sessions").select("status, meta_accepted_at, caller_phone, agency_id").eq("agency_id", args.agencyId).eq("call_id", args.callId).maybeSingle(),
        db.from("leads").select("id, phone, do_not_contact").eq("agency_id", args.agencyId).eq("id", input.leadId).maybeSingle(),
        db.from("conversations").select("id, agency_id, lead_id, ai_enabled, human_attention_required, channel").eq("agency_id", args.agencyId).eq("id", input.conversationId).eq("lead_id", input.leadId).maybeSingle(),
        db.from("quotations").select("*").eq("agency_id", args.agencyId).eq("lead_id", input.leadId).eq("id", input.quotationId).maybeSingle(),
        db.from("agencies").select("name").eq("id", args.agencyId).maybeSingle(),
      ]);
      if ([session, lead, conversation, quotation, agency].some(r => r.error)) return "ownership_lookup_failed";
      if (!session.data?.meta_accepted_at || !["accepted", "answered", "active", "connected"].includes(session.data.status)) return "call_not_live";
      if (!lead.data || lead.data.do_not_contact !== false || !conversation.data || conversation.data.ai_enabled !== true
        || conversation.data.human_attention_required || conversation.data.channel !== "whatsapp") return "conversation_not_authorized";
      const recipient = phone(lead.data.phone ?? "");
      if (recipient.length < 8 || recipient !== phone(session.data.caller_phone ?? "")) return "caller_recipient_mismatch";
      const quote = quotation.data;
      if (!quote?.public_token || !["ready", "sent", "viewed", "discussing", "accepted", "deposit_pending", "deposit_paid", "paid", "booked"].includes(quote.status)) return "quotation_not_issued";
      const requestedReference = args.transcript.match(/\bQ-[A-Z0-9]+-[A-Z0-9]+\b/i)?.[0];
      if (requestedReference && requestedReference.toUpperCase() !== String(quote.quotation_number).toUpperCase()) return "requested_quotation_mismatch";
      if (quote.customer_phone && phone(quote.customer_phone) !== recipient) return "quotation_recipient_mismatch";
      const auth = authorizeOutboundText({ conversation: { ...conversation.data, lead: { phone: recipient } }, body: renderQuotationMessage(quote, agency.data?.name ?? "UMRAIO") });
      if (!auth.ok) return "outbound_validation_failed";
      const config = await db.from("whatsapp_configs").select("phone_number_id, access_token").eq("agency_id", args.agencyId).maybeSingle();
      if (config.error || !config.data?.phone_number_id || !config.data?.access_token) return "whatsapp_unavailable";
      prepared = { to: auth.to, body: auth.body, config: config.data };
      return null;
    },
    execute: async input => {
      args.signal?.throwIfAborted();
      if (!prepared) throw new Error("action_not_authorized");
      const id = await actionId(args.agencyId, args.callId, args.sequence);
      const claim = await db.from("ai_tasks").insert({ id, agency_id: args.agencyId, lead_id: input.leadId,
        worker_key: "calling", kind: CALL_QUOTATION_TOOL, title: "Caller requested existing quotation delivery",
        status: "running", requires_approval: false, origin: "voice_call", minutes_saved: 0,
        input: { call_id: args.callId, sequence: args.sequence, quotation_id: input.quotationId, conversation_id: input.conversationId },
        started_at: new Date().toISOString(),
      });
      if (claim.error) {
        if (claim.error.code !== "23505") throw new Error("action_persistence_failed");
        const prior = await db.from("ai_tasks").select("status, output").eq("agency_id", args.agencyId).eq("id", id).maybeSingle();
        const receipt = prior.data?.output as QuotationReceipt | undefined;
        if (!prior.error && prior.data?.status === "completed" && receipt?.messageId && receipt.providerMessageId && receipt.quotationId === input.quotationId) return receipt;
        if (args.execution && !prior.error && receipt?.providerMessageId && receipt.quotationId === input.quotationId) {
          const message = await db.from("messages").select("id,provider_message_id,delivery_status")
            .eq("agency_id", args.agencyId).eq("id", id).maybeSingle();
          if (!message.error && message.data?.provider_message_id === receipt.providerMessageId && ["sent", "delivered", "read"].includes(message.data.delivery_status)) {
            const reconciled = { messageId: message.data.id, providerMessageId: receipt.providerMessageId, quotationId: input.quotationId };
            const saved = await db.from("ai_tasks").update({ status: "completed", output: reconciled, error: null, completed_at: new Date().toISOString() })
              .eq("agency_id", args.agencyId).eq("id", id).select("id").single();
            if (!saved.error && saved.data?.id) return reconciled;
          }
        }
        throw new Error("dispatch_already_claimed_unverified");
      }
      try {
        args.signal?.throwIfAborted();
        // Reuse the central, bounded Meta sender. Do not abort persistence if
        // speech ends during dispatch: record what actually happened first.
        await args.execution?.beforeDispatch?.();
        args.signal?.throwIfAborted();
        args.execution?.signal.throwIfAborted();
        dispatchStarted = true;
        const sent = args.execution
          ? await sendWhatsappTextDetailed(prepared.config.phone_number_id, prepared.config.access_token, prepared.to, prepared.body, args.execution)
          : await sendWhatsappTextDetailed(prepared.config.phone_number_id, prepared.config.access_token, prepared.to, prepared.body);
        observedSend = sent;
        if (args.execution && sent.outcome !== "verified_success") {
          const outcome = sent.outcome ?? "outcome_unknown";
          controlledResult = { ok: false, reason: sent.cause ?? outcome, outcome, dispatched: sent.dispatched ?? true };
          // Unknown delivery remains claimed; never record send_failed or resend it.
          const saved = await db.from("ai_tasks").update({ status: outcome === "outcome_unknown" ? "running" : "failed",
            output: { delivery_outcome: outcome, cause: sent.cause ?? null, dispatched: sent.dispatched ?? true,
              http_status: sent.httpStatus ?? null, quotationId: input.quotationId }, error: outcome,
          }).eq("agency_id", args.agencyId).eq("id", id).select("id").single();
          if (saved.error || !saved.data?.id) throw new Error("action_result_persistence_failed");
          throw new Error("controlled_dispatch_incomplete");
        }
        const verified = sent.ok && !!sent.providerMessageId;
        const message = await db.from("messages").insert({
          id, agency_id: args.agencyId, conversation_id: input.conversationId, sender: "ai", body: prepared.body,
          modality: "text", delivery_status: verified ? "sent" : "send_failed", provider_message_id: sent.providerMessageId,
        }).select("id, provider_message_id, delivery_status").single();
        if (message.error || !message.data?.id) throw new Error("dispatch_receipt_persistence_failed");
        if (!verified || message.data.provider_message_id !== sent.providerMessageId || message.data.delivery_status !== "sent") throw new Error("dispatch_not_verified");
        const receipt: QuotationReceipt = { messageId: message.data.id, providerMessageId: sent.providerMessageId!, quotationId: input.quotationId };
        const saved = await db.from("ai_tasks").update({ status: "completed", output: receipt, completed_at: new Date().toISOString() })
          .eq("agency_id", args.agencyId).eq("id", id).select("id").single();
        if (saved.error || !saved.data?.id) throw new Error("action_result_persistence_failed");
        await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("agency_id", args.agencyId).eq("id", input.conversationId);
        return receipt;
      } catch (error) {
        if (args.execution) {
          const providerEvidence = observedSend?.providerMessageId ? { providerMessageId: observedSend.providerMessageId, quotationId: input.quotationId } : undefined;
          controlledResult ??= { ok: false, reason: dispatchStarted ? "dispatch_unverified" : "dispatch_not_started",
            outcome: dispatchStarted ? "outcome_unknown" : "cancelled", dispatched: dispatchStarted, ...(providerEvidence ? { providerEvidence } : {}) };
          if (providerEvidence) await db.from("ai_tasks").update({ status: "running", error: "receipt_reconciliation_required",
            output: { ...providerEvidence, delivery_outcome: "outcome_unknown" },
          }).eq("agency_id", args.agencyId).eq("id", id);
          throw error;
        }
        await db.from("ai_tasks").update({ status: "failed", error: "dispatch_unverified", completed_at: new Date().toISOString() }).eq("agency_id", args.agencyId).eq("id", id);
        throw error;
      }
    },
  }]);
  try {
    const outcome = await registry.invoke(CALL_QUOTATION_TOOL, { quotationId: args.quotationId, leadId: args.leadId, conversationId: args.conversationId }, {
      supabase: db as ToolExecutionContext["supabase"], agencyId: args.agencyId, correlationId: `voice:${args.callId}:${args.sequence}`,
      grantedPermissions: ["external"], allowedTools: [CALL_QUOTATION_TOOL],
    });
    return outcome.status === "executed" ? { ok: true, receipt: outcome.result as QuotationReceipt } : controlledResult ?? { ok: false, reason: outcome.reason };
  } catch {
    return controlledResult ?? { ok: false, reason: "quotation_action_unavailable" };
  }
}

export function quotationDeliveryReply(result: CallingQuotationResult, language: string): string {
  if (result.ok) return language.startsWith("en") ? "The quotation has been sent to your WhatsApp." : "Quotation sudah dihantar ke WhatsApp. Boleh buka mesej itu ya.";
  return language.startsWith("en") ? "I can't confirm the quotation was sent. The delivery could not be completed and verified." : "Saya belum boleh sahkan quotation dihantar. Penghantaran belum dapat diselesaikan dan disahkan.";
}
