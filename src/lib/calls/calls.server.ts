/**
 * UMRAIO® — inbound WhatsApp call orchestration (server side, control plane).
 *
 * Responsibilities kept deliberately narrow:
 *  - resolve the tenant from the Meta phone_number_id (same rule as messaging),
 *  - persist an idempotent call session row per Meta call_id,
 *  - persist every state transition (monotonic, never regressing),
 *  - open a bounded answer window and, ONLY when a real media gateway exists,
 *    hand the Meta-supplied SDP offer to it, then accept the call at Meta with
 *    the gateway's REAL SDP answer.
 *
 * It never marks a call `answered` on its own. `answered` is written in exactly
 * one place — `processGatewayCallback` — and only when Meta accept already
 * succeeded AND the gateway reported real bidirectional media.
 */
import {
  CALL_ANSWER_DELAY_MS,
  isTerminalCallStatus,
  resolveMediaCapability,
  shouldApplyCallStatus,
  type ParsedCallEvent,
} from "./call-events.core";
import {
  decideGatewayCallback,
  type CallSessionRow,
  type GatewayCallbackPayload,
} from "./gateway-callback.core";
import { requestMediaSession, resolveGatewayConfig, terminateMediaSession } from "./media-gateway.server";
import { metaAcceptCall } from "./meta-calls.server";

type Db = { from: (table: string) => any };

type Tenant = { agencyId: string; accessToken: string | null };

async function resolveTenant(db: Db, phoneNumberId: string): Promise<Tenant | null> {
  const { data } = await db
    .from("whatsapp_configs")
    .select("agency_id, access_token")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  const agencyId = data?.agency_id as string | undefined;
  if (!agencyId) return null;
  return { agencyId, accessToken: (data?.access_token as string | undefined) ?? null };
}

export type CallHandlingOutcome =
  | "ignored_unknown_tenant"
  | "ringing_recorded"
  | "state_updated"
  | "state_regression_ignored"
  | "answer_deferred_media_gateway_required"
  | "answer_requested"
  | "media_negotiating"
  | "meta_accepted"
  | "negotiation_failed";

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
  fetchImpl?: typeof fetch;
}): Promise<CallHandlingOutcome> {
  const { db, event, phoneNumberId } = args;
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const now = args.now ?? (() => new Date());

  const tenant = await resolveTenant(db, phoneNumberId);
  if (!tenant) {
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
      agency_id: tenant.agencyId,
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
    return maybeRequestAnswer({ db, event, env, nowIso, tenant, phoneNumberId, now, ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) });
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

  // A caller who hangs up mid-negotiation must not leave media running.
  if (isTerminalCallStatus(event.status)) {
    const gateway = resolveGatewayConfig(env);
    if (gateway && existing.status === "media_negotiating") {
      await terminateMediaSession({
        gatewayUrl: gateway.url,
        secret: gateway.secret,
        callId: event.callId,
        agencyId: tenant.agencyId,
        phoneNumberId,
        reason: "caller_terminated",
        now: now(),
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      }).catch(() => undefined);
    }
  }
  return "state_updated";
}

async function markFailed(db: Db, callId: string, reason: string, nowIso: string): Promise<void> {
  await db
    .from("whatsapp_call_sessions")
    .update({ status: "failed", ended_at: nowIso, termination_reason: reason })
    .eq("call_id", callId);
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
  tenant: Tenant;
  phoneNumberId: string;
  now: () => Date;
  fetchImpl?: typeof fetch;
}): Promise<CallHandlingOutcome> {
  const { db, event, env, nowIso, tenant, phoneNumberId, now } = args;
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
  const gateway = resolveGatewayConfig(env);
  if (!gateway) {
    console.log(`[calls] answer_deferred call_id=${event.callId} reason=gateway_secret_missing`);
    return "answer_deferred_media_gateway_required";
  }

  await db
    .from("whatsapp_call_sessions")
    .update({ status: "answer_requested", answer_requested_at: nowIso })
    .eq("call_id", event.callId);
  console.log(`[calls] answer_requested call_id=${event.callId} gateway=configured`);

  const fetchOpt = args.fetchImpl ? { fetchImpl: args.fetchImpl } : {};

  // 1) Real SDP offer from Meta -> gateway -> real SDP answer.
  const media = await requestMediaSession({
    gatewayUrl: gateway.url,
    secret: gateway.secret,
    callId: event.callId,
    agencyId: tenant.agencyId,
    phoneNumberId,
    sdpOffer: event.sdp.sdp,
    now: now(),
    ...fetchOpt,
  });
  if (!media.ok) {
    console.log(`[calls] media_session_failed call_id=${event.callId} reason=${media.reason}`);
    await markFailed(db, event.callId, media.reason, now().toISOString());
    return "negotiation_failed";
  }

  await db
    .from("whatsapp_call_sessions")
    .update({
      status: "media_negotiating",
      gateway_session_id: media.sessionId,
      media_negotiated_at: now().toISOString(),
    })
    .eq("call_id", event.callId);
  console.log(`[calls] media_negotiating call_id=${event.callId} session_id=${media.sessionId}`);

  // 2) Accept at Meta with the gateway's REAL answer. Still not "answered".
  if (!tenant.accessToken) {
    await markFailed(db, event.callId, "meta_token_missing", now().toISOString());
    return "negotiation_failed";
  }
  const accepted = await metaAcceptCall({
    phoneNumberId,
    accessToken: tenant.accessToken,
    callId: event.callId,
    sdpAnswer: media.sdpAnswer,
    ...fetchOpt,
  });
  if (!accepted.ok) {
    console.log(`[calls] meta_accept_failed call_id=${event.callId} reason=${accepted.reason}`);
    await terminateMediaSession({
      gatewayUrl: gateway.url,
      secret: gateway.secret,
      callId: event.callId,
      agencyId: tenant.agencyId,
      phoneNumberId,
      reason: "meta_accept_failed",
      now: now(),
      ...fetchOpt,
    }).catch(() => undefined);
    await markFailed(db, event.callId, accepted.reason, now().toISOString());
    return "negotiation_failed";
  }

  await db
    .from("whatsapp_call_sessions")
    .update({ meta_accepted_at: now().toISOString() })
    .eq("call_id", event.callId);
  console.log(`[calls] meta_accept_ok call_id=${event.callId} awaiting=media_ready`);
  return "meta_accepted";
}

export type GatewayCallbackOutcome =
  | { applied: true; outcome: "answered" | "terminated" | "failed" | "negotiating" }
  | { applied: false; rejection: string };

/**
 * Applies ONE verified gateway callback. The HTTP layer has already proven the
 * HMAC and freshness; correlation, replay and the answered rule are enforced
 * here against the Worker's own row — never against gateway-supplied tenancy.
 */
export async function processGatewayCallback(args: {
  db: Db;
  payload: GatewayCallbackPayload;
  now?: () => Date;
}): Promise<GatewayCallbackOutcome> {
  const { db, payload } = args;
  const now = args.now ?? (() => new Date());

  const { data } = await db
    .from("whatsapp_call_sessions")
    .select("id, call_id, status, gateway_session_id, meta_accepted_at, callback_nonces")
    .eq("call_id", payload.call_id)
    .maybeSingle();

  const session = (data as CallSessionRow | null) ?? null;
  const decision = decideGatewayCallback({ payload, session, now: now() });

  if (!decision.apply) {
    console.log(
      `[calls] gateway_callback_rejected call_id=${payload.call_id} event=${payload.event} reason=${decision.rejection}`,
    );
    return { applied: false, rejection: decision.rejection };
  }

  // Compare-and-set: a session-id bind is only allowed while the column is NULL,
  // so a concurrent Establish response can never be overwritten by a callback.
  let query = db.from("whatsapp_call_sessions").update(decision.patch).eq("id", session!.id);
  if (decision.requireNullGatewaySession) query = query.is("gateway_session_id", null);
  await query;
  console.log(
    `[calls] gateway_callback_applied call_id=${payload.call_id} event=${payload.event} outcome=${decision.outcome}`,
  );
  return { applied: true, outcome: decision.outcome };
}
