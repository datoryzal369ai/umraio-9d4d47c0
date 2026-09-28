import type { SupabaseClient } from "@supabase/supabase-js";

import { readAutonomySettings } from "@/lib/executive-autonomy.server";
import { notify } from "@/lib/task-engine.server";
import { draftSupportEmailReply } from "./email-intelligence.server";
import { sendSupportEmail } from "./email-transport.server";
import { isAutonomousEmailCareEnabled } from "./policy.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type InboundSupportEmail = {
  agencyId: string;
  externalThreadId: string;
  customerEmail: string;
  subject: string;
  body: string;
  providerMessageId?: string | null;
  locale?: string;
};

async function ensureThread(supabase: Db, input: InboundSupportEmail): Promise<string> {
  const { data: existing } = await supabase
    .from("support_email_threads")
    .select("id")
    .eq("agency_id", input.agencyId)
    .eq("external_thread_id", input.externalThreadId)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created, error } = await supabase
    .from("support_email_threads")
    .insert({
      agency_id: input.agencyId,
      external_thread_id: input.externalThreadId,
      customer_email: input.customerEmail.trim().toLowerCase(),
      subject: input.subject.slice(0, 500),
      status: "open",
      ai_enabled: true,
      last_message_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !created?.id) throw new Error(error?.message ?? "SUPPORT_EMAIL_THREAD_CREATE_FAILED");
  return created.id as string;
}

export async function processInboundSupportEmail(
  supabase: Db,
  input: InboundSupportEmail,
): Promise<{
  threadId: string;
  status: "sent" | "pending_approval" | "send_failed";
  draft: string;
  reasonCode: string;
}> {
  const threadId = await ensureThread(supabase, input);

  if (input.providerMessageId) {
    const { data: duplicate } = await supabase
      .from("support_email_messages")
      .select("id")
      .eq("agency_id", input.agencyId)
      .eq("provider_message_id", input.providerMessageId)
      .maybeSingle();
    if (duplicate?.id) {
      return {
        threadId,
        status: "pending_approval",
        draft: "",
        reasonCode: "DUPLICATE_PROVIDER_MESSAGE",
      };
    }
  }

  const { error: inboundError } = await supabase.from("support_email_messages").insert({
    agency_id: input.agencyId,
    thread_id: threadId,
    direction: "inbound",
    sender: "customer",
    body: input.body.slice(0, 20000),
    provider_message_id: input.providerMessageId ?? null,
    delivery_status: "received",
  });
  if (inboundError) throw new Error(inboundError.message);

  const draft = await draftSupportEmailReply(supabase, input);
  const { autonomyMode } = await readAutonomySettings(supabase, input.agencyId);
  const mayAutoSend =
    autonomyMode === "autonomous" &&
    isAutonomousEmailCareEnabled() &&
    !draft.requiresApproval &&
    !draft.escalationRequired &&
    draft.confidence >= 0.78;

  let deliveryStatus: "sent" | "pending_approval" | "send_failed" = "pending_approval";
  let outboundProviderId: string | null = null;

  if (mayAutoSend) {
    const sent = await sendSupportEmail({
      to: input.customerEmail,
      subject: /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`,
      text: draft.reply,
      idempotencyKey: `umraio-support:${threadId}:${input.providerMessageId ?? "inbound"}`,
    });
    deliveryStatus = sent.ok ? "sent" : "send_failed";
    outboundProviderId = sent.ok ? sent.providerMessageId : null;
  }

  const { error: draftError } = await supabase.from("support_email_messages").insert({
    agency_id: input.agencyId,
    thread_id: threadId,
    direction: "outbound",
    sender: "ai",
    body: draft.reply,
    provider_message_id: outboundProviderId,
    delivery_status: deliveryStatus,
    requires_approval: deliveryStatus !== "sent",
    confidence: draft.confidence,
    reason_code: draft.reasonCode,
    category: draft.category,
  });
  if (draftError) throw new Error(draftError.message);

  await supabase
    .from("support_email_threads")
    .update({
      last_message_at: new Date().toISOString(),
      status: deliveryStatus === "sent" ? "open" : "pending_human",
    })
    .eq("agency_id", input.agencyId)
    .eq("id", threadId);

  await supabase.from("activity_log").insert({
    agency_id: input.agencyId,
    actor: "ai",
    action:
      deliveryStatus === "sent"
        ? "Autonomous customer-care email sent"
        : deliveryStatus === "send_failed"
          ? "Autonomous customer-care email send failed"
          : "Customer-care email drafted for approval",
    entity: "support_email_thread",
    entity_id: threadId,
    meta: {
      delivery_status: deliveryStatus,
      confidence: draft.confidence,
      reason_code: draft.reasonCode,
      category: draft.category,
      provider_message_id: outboundProviderId,
    },
  });

  if (deliveryStatus !== "sent") {
    await notify(supabase, input.agencyId, {
      kind: "customer_care_email_review",
      severity: deliveryStatus === "send_failed" ? "critical" : "warning",
      title:
        deliveryStatus === "send_failed"
          ? "Customer-care email send failed"
          : "Customer-care email needs approval",
      body: draft.reasonCode,
      entity: "support_email_thread",
      entityId: threadId,
    });
  }

  return {
    threadId,
    status: deliveryStatus,
    draft: draft.reply,
    reasonCode: draft.reasonCode,
  };
}
