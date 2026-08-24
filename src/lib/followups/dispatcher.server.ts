import type { SupabaseClient } from "@supabase/supabase-js";

import { sendWhatsappText } from "../whatsapp-send.server";
import { QuotaError, assertQuota, recordUsageEvent } from "../billing/usage.server";
import { logConversionEvent } from "../quotations/quotations.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * UMRAIO® FOLLOW-UP DISPATCHER.
 *
 * Activates the existing `followup_jobs` queue. Safety rules are deterministic
 * and enforced here, never by a model:
 *
 *  - only jobs that carry an explicit customer-facing `body` are sent;
 *    internal handover/attention tasks are left for humans,
 *  - never sends when the conversation is under human takeover,
 *  - never sends to a lead that already replied after the job was scheduled,
 *  - respects agency quiet hours (09:00–21:00 local),
 *  - one message per lead per dispatch cycle, with a hard cycle ceiling,
 *  - fails closed on quota.
 */

const MAX_PER_CYCLE = 5;
const QUIET_START_HOUR = 9;
const QUIET_END_HOUR = 21;

/**
 * B-3.1 — transport retry policy.
 *
 * Only transport-level failures are retried. Business refusals (DNC, human
 * takeover, customer replied, quota denial, missing configuration) are never
 * retried: they are recorded as `skipped` with a reason, exactly as before.
 *
 * `attempts` is incremented by the atomic claim, so attempt N means the job has
 * already been claimed N times.
 */
export const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MINUTES = [5, 30];

export function nextRetryAt(attempts: number, from = new Date()): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const minutes = RETRY_BACKOFF_MINUTES[attempts - 1] ?? RETRY_BACKOFF_MINUTES.at(-1)!;
  return new Date(from.getTime() + minutes * 60_000);
}


export function localHour(timezone: string | null | undefined, at = new Date()): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone || "Asia/Kuala_Lumpur",
    }).format(at);
    return Number(formatted);
  } catch {
    return at.getUTCHours() + 8;
  }
}

export function withinSendWindow(hour: number) {
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

export type DispatchResult = {
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
  details: Array<{ id: string; outcome: string; reason?: string }>;
};

async function markJob(
  supabase: Db,
  id: string,
  status: "pending" | "sent" | "skipped" | "failed",
  patch: Record<string, unknown> = {},
) {
  await supabase
    .from("followup_jobs")
    .update({ status, ...patch })
    .eq("id", id);
}

/**
 * Atomic claim. The database moves pending -> processing and increments
 * `attempts` in one statement, so two concurrent cron runs can never both send
 * the same follow-up. A job stuck in `processing` (crash mid-send) becomes
 * claimable again after the stale window inside `claim_followup_job`.
 *
 * Unavoidable ambiguity, documented deliberately: the external WhatsApp send
 * cannot join the database transaction. If the send succeeds but the follow-up
 * database update then fails, the job stays `processing` and may be re-sent
 * once after the stale window. We guarantee at-most-one *active* sender, not
 * exactly-once delivery.
 */
async function claimJob(supabase: Db, agencyId: string, jobId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("claim_followup_job", {
    p_job_id: jobId,
    p_agency_id: agencyId,
  });
  if (error) {
    console.error(`[followups] claim_failed job=${jobId} code=${error.code ?? "unknown"}`);
    return false;
  }
  return data === true;
}


export async function dispatchDueFollowups(
  supabase: Db,
  agencyId: string,
  limit = MAX_PER_CYCLE,
): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, failed: 0, retried: 0, details: [] };

  const { data: agency } = await supabase
    .from("agencies")
    .select("timezone")
    .eq("id", agencyId)
    .maybeSingle();

  if (!withinSendWindow(localHour(agency?.timezone))) {
    return result;
  }

  // Only actionable jobs enter the dispatch window. Body-less rows are internal
  // human-handover tasks: they stay pending for people, but must never occupy
  // the sendable batch (head-of-line blocking).
  const { data: jobs } = await supabase
    .from("followup_jobs")
    .select(
      "id, lead_id, conversation_id, quotation_id, title, body, run_at, channel, created_at, attempts",
    )
    .eq("agency_id", agencyId)
    // `processing` rows are included so a crashed mid-send job can be recovered;
    // the atomic claim still refuses any row that is not stale.
    .in("status", ["pending", "processing"])
    .eq("channel", "whatsapp")
    .not("body", "is", null)
    .neq("body", "")
    .lte("run_at", new Date().toISOString())
    .order("run_at", { ascending: true })
    .limit(limit * 4);


  if (!jobs?.length) return result;

  const { data: config } = await supabase
    .from("whatsapp_configs")
    .select("phone_number_id, access_token, is_connected, auto_reply")
    .eq("agency_id", agencyId)
    .maybeSingle();

  const contactedLeads = new Set<string>();

  for (const job of jobs) {
    if (result.sent >= limit) break;

    const skip = async (reason: string) => {
      await markJob(supabase, job.id, "skipped", { skip_reason: reason });
      result.skipped += 1;
      result.details.push({ id: job.id, outcome: "skipped", reason });
    };

    // 1. Only explicit customer-facing follow-ups are ever sent.
    const body = (job.body ?? "").trim();
    if (!body) {
      result.details.push({ id: job.id, outcome: "left_for_human" });
      continue;
    }
    if (!job.lead_id) {
      await skip("No lead attached");
      continue;
    }
    if (contactedLeads.has(job.lead_id)) continue;

    const { data: lead } = await supabase
      .from("leads")
      .select("id, phone, stage, last_contact_at, full_name, do_not_contact")
      .eq("id", job.lead_id)
      .maybeSingle();
    // Step 3.6 — do-not-contact is absolute and outranks every other rule.
    if (lead?.do_not_contact) {
      await skip("Customer requested no further contact");
      continue;
    }
    if (!lead?.phone) {
      await skip("Lead has no WhatsApp number");
      continue;
    }
    if (["booked", "completed", "lost"].includes(lead.stage)) {
      await skip(`Lead is already ${lead.stage}`);
      continue;
    }

    // 2. The customer replied after this nudge was scheduled — do not chase.
    if (
      lead.last_contact_at &&
      new Date(lead.last_contact_at).getTime() > new Date(job.created_at).getTime()
    ) {
      await skip("Customer already replied after this follow-up was scheduled");
      continue;
    }

    // 3. Human takeover always wins.
    const { data: conversation } = await supabase
      .from("conversations")
      .select("id, ai_enabled, external_id")
      .eq("agency_id", agencyId)
      .eq("lead_id", lead.id)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (conversation && conversation.ai_enabled === false) {
      await skip("Conversation is under human takeover");
      continue;
    }

    if (!config?.access_token || !config.phone_number_id) {
      await skip("WhatsApp is not connected");
      continue;
    }

    // 4. Commercial safety — a follow-up is a customer-facing message.
    try {
      await assertQuota(supabase, agencyId, "customer_reply");
    } catch (err) {
      if (err instanceof QuotaError) {
        await skip("AI reply allowance reached");
        continue;
      }
      throw err;
    }

    // 5. Atomic claim — the last gate before the external send. Every business
    //    safety rule above has already passed, and no other cron run can now
    //    take this job.
    const claimed = await claimJob(supabase, agencyId, job.id);
    if (!claimed) {
      result.details.push({ id: job.id, outcome: "not_claimed" });
      continue;
    }
    const attempt = (job.attempts ?? 0) + 1;

    const to = conversation?.external_id || lead.phone;
    const ok = await sendWhatsappText(config.phone_number_id, config.access_token, to, body);
    if (!ok) {
      // Transport failure only — business refusals never reach this branch.
      const retryAt = nextRetryAt(attempt);
      if (retryAt) {
        await markJob(supabase, job.id, "pending", {
          run_at: retryAt.toISOString(),
          claimed_at: null,
          last_error: "WhatsApp send failed",
        });
        result.retried += 1;
        result.details.push({ id: job.id, outcome: "retry_scheduled", reason: "WhatsApp send failed" });
      } else {
        await markJob(supabase, job.id, "failed", {
          skip_reason: "WhatsApp send failed",
          last_error: "WhatsApp send failed",
          claimed_at: null,
        });
        result.failed += 1;
        result.details.push({ id: job.id, outcome: "failed", reason: "Max attempts reached" });
      }
      continue;
    }


    const now = new Date().toISOString();
    await markJob(supabase, job.id, "sent", { dispatched_at: now, claimed_at: null });
    contactedLeads.add(lead.id);
    result.sent += 1;
    result.details.push({ id: job.id, outcome: "sent" });

    if (conversation?.id) {
      await supabase.from("messages").insert({
        agency_id: agencyId,
        conversation_id: conversation.id,
        sender: "ai",
        body,
      });
      await supabase
        .from("conversations")
        .update({ last_message_at: now })
        .eq("id", conversation.id);
    }
    await supabase.from("leads").update({ last_contact_at: now }).eq("id", lead.id);
    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "ai",
      action: `Follow-up sent on WhatsApp: ${job.title}`,
      entity: "lead",
      entity_id: lead.id,
      meta: { followup_id: job.id, preview: body.slice(0, 160) },
    });
    await recordUsageEvent(supabase, {
      agencyId,
      eventKey: `followup:${job.id}`,
      category: "customer_reply",
      operation: "followup_dispatch",
      worker: "whatsapp",
      success: true,
      meta: { followup_id: job.id },
    });
    await logConversionEvent(supabase, {
      agencyId,
      stage: "followup_sent",
      actor: "ai",
      leadId: lead.id,
      quotationId: job.quotation_id ?? null,
      meta: { followup_id: job.id },
    });

    if (job.quotation_id) {
      await supabase
        .from("quotations")
        .update({ status: "sent", sent_at: now })
        .eq("id", job.quotation_id)
        .in("status", ["ready"]);
    }
  }

  return result;
}
