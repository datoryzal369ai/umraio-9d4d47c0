import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const inputSchema = z.object({
  messageId: z.string().uuid(),
});

export type ApprovedSupportEmailResult =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      reason:
        | "NOT_AUTHORIZED"
        | "DRAFT_NOT_FOUND"
        | "DRAFT_NOT_SENDABLE"
        | "THREAD_NOT_FOUND"
        | "EMAIL_PROVIDER_NOT_CONFIGURED"
        | "SEND_FAILED";
    };

/**
 * Explicit human approval/retry surface for a stored support-email draft.
 * Only owner/admin/platform_owner may send. The AI runtime cannot invoke this
 * browser-authenticated server function by itself.
 */
export const approveAndSendSupportEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: z.infer<typeof inputSchema>) => inputSchema.parse(input))
  .handler(async ({ data, context }): Promise<ApprovedSupportEmailResult> => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const roleNames = (roles ?? []).map((row) => String(row.role));
    const authorized = roleNames.some((role) =>
      ["owner", "admin", "platform_owner"].includes(role),
    );
    if (!authorized) return { ok: false, reason: "NOT_AUTHORIZED" };

    // Read through the caller's RLS client first. This proves agency ownership
    // before service-role access is used for the delivery-status update.
    const { data: draft } = await context.supabase
      .from("support_email_messages")
      .select(
        "id, agency_id, thread_id, body, direction, delivery_status, requires_approval, created_at",
      )
      .eq("id", data.messageId)
      .maybeSingle();
    if (!draft) return { ok: false, reason: "DRAFT_NOT_FOUND" };
    if (
      draft.direction !== "outbound" ||
      !["pending_approval", "send_failed"].includes(String(draft.delivery_status))
    ) {
      return { ok: false, reason: "DRAFT_NOT_SENDABLE" };
    }

    const { data: thread } = await context.supabase
      .from("support_email_threads")
      .select("id, agency_id, customer_email, subject")
      .eq("id", draft.thread_id)
      .eq("agency_id", draft.agency_id)
      .maybeSingle();
    if (!thread) return { ok: false, reason: "THREAD_NOT_FOUND" };

    const { sendSupportEmail } = await import("@/lib/customer-care/email-transport.server");
    const sent = await sendSupportEmail({
      to: thread.customer_email,
      subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`,
      text: draft.body,
      idempotencyKey: `umraio-support-approved:${draft.id}`,
    });

    if (!sent.ok) {
      if (sent.reason === "EMAIL_PROVIDER_NOT_CONFIGURED") {
        return { ok: false, reason: "EMAIL_PROVIDER_NOT_CONFIGURED" };
      }
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("support_email_messages")
        .update({ delivery_status: "send_failed" })
        .eq("id", draft.id)
        .eq("agency_id", draft.agency_id);
      return { ok: false, reason: "SEND_FAILED" };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("support_email_messages")
      .update({
        delivery_status: "sent",
        provider_message_id: sent.providerMessageId,
        requires_approval: false,
      })
      .eq("id", draft.id)
      .eq("agency_id", draft.agency_id);

    await supabaseAdmin
      .from("support_email_threads")
      .update({ status: "open", last_message_at: new Date().toISOString() })
      .eq("id", draft.thread_id)
      .eq("agency_id", draft.agency_id);

    await supabaseAdmin.from("activity_log").insert({
      agency_id: draft.agency_id,
      actor: "human",
      action: "Approved customer-care email sent",
      entity: "support_email_thread",
      entity_id: draft.thread_id,
      meta: {
        approved_by: context.userId,
        message_id: draft.id,
        provider_message_id: sent.providerMessageId,
      },
    });

    return { ok: true, providerMessageId: sent.providerMessageId };
  });
