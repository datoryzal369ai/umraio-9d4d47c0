/**
 * UMRAIO® — inbound WhatsApp call orchestration (server side).
 *
 * Responsibilities kept deliberately narrow:
 *  - resolve the tenant from the Meta phone_number_id (same rule as messaging),
 *  - persist an idempotent call session row per Meta call_id,
 *  - persist every state transition (monotonic, never regressing),
 *  - open a bounded answer window and, ONLY when a real media gateway exists,
 *    hand the Meta-supplied SDP offer to it.
 *
 * It never marks a call `answered` on its own: `answered` requires a confirmed
 * establishment result carrying real remote SDP.
 */
import {
  CALL_ANSWER_DELAY_MS,
  isTerminalCallStatus,
  resolveMediaCapability,
  shouldApplyCallStatus,
  type ParsedCallEvent,
} from "./call-events.core";

type Db = { from: (table: string) => any };

async function resolveAgencyId(db: Db, phoneNumberId: string): Promise<string | null> {
  const { data } = await db
    .from("whatsapp_configs")
    .select("agency_id")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  return (data?.agency_id as string | undefined) ?? null;
}

export type CallHandlingOutcome =
  | "ignored_unknown_tenant"
  | "ringing_recorded"
  | "state_updated"
  | "state_regression_ignored"
  | "answer_deferred_media_gateway_required"
  | "answer_requested";

/**
 * Processes ONE Meta call event. Returns quickly; the answer window is opened
 * as recorded state (a deadline timestamp), never by blocking the webhook.
 */
export async function processCallEvent(args: {
  db: Db;
  event: ParsedCallEvent;
  phoneNumberId: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}): Promise<CallHandlingOutcome> {
  const { db, event, phoneNumberId } = args;
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const now = args.now ?? (() => new Date());

  const agencyId = await resolveAgencyId(db, phoneNumberId);
  if (!agencyId) {
    console.log(`[calls] call_event_ignored reason=config_not_found call_id=${event.callId}`);
    return "ignored_unknown_tenant";
  }

  const { data: existing } = await db
    .from("whatsapp_call_sessions")
    .select("id, status")
    .eq("call_id", event.callId)
    .maybeSingle();

  const nowIso = now().toISOString();

  if (!existing) {
    const deadline =
      event.status === "ringing"
        ? new Date(now().getTime() + CALL_ANSWER_DELAY_MS).toISOString()
        : null;
    await db.from("whatsapp_call_sessions").insert({
      agency_id: agencyId,
      call_id: event.callId,
      phone_number_id: phoneNumberId,
      caller_phone: event.callerPhone,
      direction: event.direction,
      status: event.status,
      received_at: event.occurredAt,
      answer_deadline_at: deadline,
      ended_at: isTerminalCallStatus(event.status) ? event.occurredAt : null,
      termination_reason: event.terminationReason,
    });
    console.log(
      `[calls] call_session_created call_id=${event.callId} status=${event.status} has_sdp=${Boolean(event.sdp)}`,
    );
    if (event.status !== "ringing") return "state_updated";
    return maybeRequestAnswer({ db, event, env, nowIso });
  }

  if (!shouldApplyCallStatus(existing.status, event.status)) {
    console.log(
      `[calls] call_state_ignored reason=regression call_id=${event.callId} current=${existing.status} incoming=${event.status}`,
    );
    return "state_regression_ignored";
  }

  await db
    .from("whatsapp_call_sessions")
    .update({
      status: event.status,
      ended_at: isTerminalCallStatus(event.status) ? event.occurredAt : null,
      termination_reason: event.terminationReason,
    })
    .eq("id", existing.id);
  console.log(
    `[calls] call_state_transition call_id=${event.callId} from=${existing.status} to=${event.status} reason=${event.terminationReason ?? "none"}`,
  );
  return "state_updated";
}

/**
 * The answer decision. With no media gateway the platform CANNOT establish the
 * call, so nothing is sent to Meta and no `answered` state is written — the
 * call is left ringing until Meta reports the real outcome.
 */
async function maybeRequestAnswer(args: {
  db: Db;
  event: ParsedCallEvent;
  env: Record<string, string | undefined>;
  nowIso: string;
}): Promise<CallHandlingOutcome> {
  const { db, event, env, nowIso } = args;
  const capability = resolveMediaCapability(env);
  if (!capability.supported) {
    console.log(
      `[calls] answer_deferred call_id=${event.callId} reason=media_gateway_required has_sdp=${Boolean(event.sdp)}`,
    );
    return "answer_deferred_media_gateway_required";
  }
  if (!event.sdp) {
    console.log(`[calls] answer_deferred call_id=${event.callId} reason=missing_remote_sdp`);
    return "answer_deferred_media_gateway_required";
  }
  await db
    .from("whatsapp_call_sessions")
    .update({ status: "answer_requested", answer_requested_at: nowIso })
    .eq("call_id", event.callId);
  console.log(`[calls] answer_requested call_id=${event.callId} gateway=configured`);
  return "answer_requested";
}
