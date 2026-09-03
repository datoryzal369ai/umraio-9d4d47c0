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
import {
  notifyCallAccepted,
  requestMediaSession,
  resolveGatewayConfig,
  terminateMediaSession,
} from "./media-gateway.server";
import { metaAcceptCall, metaPreAcceptCall } from "./meta-calls.server";
import { CallTimeline, mergeCallTimings, type CallTimings } from "./call-timings.core";

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
  | "meta_pre_accepted"
  | "meta_accepted"
  | "cancelled_by_terminate"
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

  const timeline = new CallTimeline(now);
  timeline.mark("webhook_received_at");

  const tenant = await resolveTenant(db, phoneNumberId);
  if (!tenant) {
    console.log(`[calls] call_event_ignored reason=config_not_found call_id=${event.callId}`);
    return "ignored_unknown_tenant";
  }
  timeline.mark("tenant_resolved_at");

  const { data: existing } = await db
    .from("whatsapp_call_sessions")
    .select("id, status, stage_timings")
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
    return maybeRequestAnswer({ db, event, env, nowIso, tenant, phoneNumberId, now, timeline, ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) });
  }

  if (!shouldApplyCallStatus(existing.status, event.status)) {
    console.log(
      `[calls] call_state_ignored reason=regression call_id=${event.callId} current=${existing.status} incoming=${event.status}`,
    );
    return "state_regression_ignored";
  }

  const terminal = isTerminalCallStatus(event.status);
  const statusPatch: Record<string, unknown> = {
    status: event.status,
    ended_at: terminal ? event.occurredAt : null,
    termination_reason: event.terminationReason,
  };
  if (terminal) {
    timeline.mark("terminate_received_at", new Date(event.occurredAt));
    statusPatch["stage_timings"] = mergeCallTimings(existing.stage_timings, timeline.snapshot());
  }
  await db.from("whatsapp_call_sessions").update(statusPatch).eq("id", existing.id);
  console.log(
    `[calls] call_state_transition call_id=${event.callId} from=${existing.status} to=${event.status} reason=${event.terminationReason ?? "none"}`,
  );

  // A caller who hangs up mid-negotiation must not leave media running.
  if (terminal) {
    const gateway = resolveGatewayConfig(env);
    if (gateway && NEGOTIATION_STATUSES.has(existing.status)) {
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

async function markFailed(
  db: Db,
  callId: string,
  reason: string,
  nowIso: string,
  timings?: CallTimings,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: "failed",
    ended_at: nowIso,
    termination_reason: reason,
  };
  if (timings) patch["stage_timings"] = timings;
  await db.from("whatsapp_call_sessions").update(patch).eq("call_id", callId);
}

/** Statuses in which media negotiation is (or may be) in flight. */
const NEGOTIATION_STATUSES = new Set([
  "answer_requested",
  "media_negotiating",
  "meta_pre_accepted",
]);

/**
 * Authoritative liveness re-check. Called immediately before and immediately
 * after every Meta call action so a TERMINATE that landed in a concurrent
 * webhook invocation can cancel the answer instead of being overwritten.
 */
async function isCallStillActive(db: Db, callId: string): Promise<boolean> {
  const { data } = await db
    .from("whatsapp_call_sessions")
    .select("status")
    .eq("call_id", callId)
    .maybeSingle();
  const status = (data?.status as string | undefined) ?? null;
  if (!status) return false;
  return !isTerminalCallStatus(status) && status !== "answered";
}

/**
 * The answer decision. With no media gateway the platform CANNOT establish the
 * call, so nothing is sent to Meta and no `answered` state is written — the
 * call is left ringing until Meta reports the real outcome.
 *
 * Critical path only: tenant/security resolution, gateway negotiation, Meta
 * pre_accept, Meta accept. Nothing else (analytics, AI, CRM, greeting, TTS)
 * runs before the call is accepted.
 */
async function maybeRequestAnswer(args: {
  db: Db;
  event: ParsedCallEvent;
  env: Record<string, string | undefined>;
  nowIso: string;
  tenant: Tenant;
  phoneNumberId: string;
  now: () => Date;
  timeline: CallTimeline;
  fetchImpl?: typeof fetch;
}): Promise<CallHandlingOutcome> {
  const { db, event, env, nowIso, tenant, phoneNumberId, now, timeline } = args;
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

  const teardown = (reason: string) =>
    terminateMediaSession({
      gatewayUrl: gateway.url,
      secret: gateway.secret,
      callId: event.callId,
      agencyId: tenant.agencyId,
      phoneNumberId,
      reason,
      now: now(),
      ...fetchOpt,
    }).catch(() => undefined);

  // 1) Real SDP offer from Meta -> gateway -> real SDP answer. No delay.
  timeline.mark("gateway_offer_started_at");
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
    await markFailed(db, event.callId, media.reason, now().toISOString(), timeline.snapshot());
    return "negotiation_failed";
  }
  timeline.mark("gateway_answer_received_at");

  await db
    .from("whatsapp_call_sessions")
    .update({
      status: "media_negotiating",
      gateway_session_id: media.sessionId,
      media_negotiated_at: now().toISOString(),
      stage_timings: timeline.snapshot(),
    })
    .eq("call_id", event.callId);
  console.log(`[calls] media_negotiating call_id=${event.callId} session_id=${media.sessionId}`);

  if (!tenant.accessToken) {
    await teardown("meta_token_missing");
    await markFailed(db, event.callId, "meta_token_missing", now().toISOString(), timeline.snapshot());
    return "negotiation_failed";
  }

  const cancelled = async (phase: string): Promise<CallHandlingOutcome> => {
    console.log(`[calls] answer_cancelled call_id=${event.callId} phase=${phase} reason=call_terminated`);
    await teardown("call_terminated");
    await db
      .from("whatsapp_call_sessions")
      .update({ stage_timings: timeline.snapshot() })
      .eq("call_id", event.callId);
    return "cancelled_by_terminate";
  };

  // 2) PRE-ACCEPT with the gateway's REAL answer: lets ICE/DTLS establish
  //    before the final accept. Never implies "answered".
  if (!(await isCallStillActive(db, event.callId))) return cancelled("before_pre_accept");
  timeline.mark("meta_pre_accept_started_at");
  const preAccepted = await metaPreAcceptCall({
    phoneNumberId,
    accessToken: tenant.accessToken,
    callId: event.callId,
    sdpAnswer: media.sdpAnswer,
    ...fetchOpt,
  });
  if (preAccepted.ok) {
    timeline.mark("meta_pre_accept_completed_at");
    if (!(await isCallStillActive(db, event.callId))) return cancelled("after_pre_accept");
    await db
      .from("whatsapp_call_sessions")
      .update({
        status: "meta_pre_accepted",
        meta_pre_accepted_at: timeline.get("meta_pre_accept_completed_at"),
        stage_timings: timeline.snapshot(),
      })
      .eq("call_id", event.callId);
    console.log(`[calls] meta_pre_accept_ok call_id=${event.callId}`);
  } else {
    // Documented fallback: when pre_accept cannot be completed, proceed
    // straight to accept rather than dropping the call.
    console.log(`[calls] meta_pre_accept_failed call_id=${event.callId} reason=${preAccepted.reason}`);
  }

  // 3) Final accept, with the SAME SDP answer Meta already saw on pre_accept.
  if (!(await isCallStillActive(db, event.callId))) return cancelled("before_accept");
  timeline.mark("meta_accept_started_at");
  const accepted = await metaAcceptCall({
    phoneNumberId,
    accessToken: tenant.accessToken,
    callId: event.callId,
    sdpAnswer: media.sdpAnswer,
    ...fetchOpt,
  });
  if (!accepted.ok) {
    console.log(`[calls] meta_accept_failed call_id=${event.callId} reason=${accepted.reason}`);
    await teardown("meta_accept_failed");
    await markFailed(db, event.callId, accepted.reason, now().toISOString(), timeline.snapshot());
    return "negotiation_failed";
  }
  timeline.mark("meta_accept_completed_at");

  // A TERMINATE that landed while accept was in flight must NOT be revived.
  if (!(await isCallStillActive(db, event.callId))) return cancelled("after_accept");

  await db
    .from("whatsapp_call_sessions")
    .update({
      meta_accepted_at: timeline.get("meta_accept_completed_at"),
      stage_timings: timeline.snapshot(),
    })
    .eq("call_id", event.callId);
  console.log(
    `[calls] meta_accept_ok call_id=${event.callId} awaiting=media_ready pre_accept=${preAccepted.ok} ${timeline.logLine()}`,
  );

  // 4) Post-accept notification. Exactly one greeting is started by the
  //    gateway here — never earlier (the turn endpoint rejects a call Meta has
  //    not accepted) and never again (the gateway keeps it idempotent). A
  //    TERMINATE that already closed the media session yields "closed".
  const notified = await notifyCallAccepted({
    gatewayUrl: gateway.url,
    secret: gateway.secret,
    callId: event.callId,
    agencyId: tenant.agencyId,
    phoneNumberId,
    now: now(),
    ...fetchOpt,
  });
  console.log(
    `[calls] post_accept_notify call_id=${event.callId} ok=${notified.ok} greeting=${notified.greeting ?? notified.reason ?? "unknown"}`,
  );
  await db
    .from("whatsapp_call_sessions")
    .update({
      stage_timings: mergeCallTimings(timeline.snapshot(), {
        post_accept_notified_at: now().toISOString(),
      }),
    })
    .eq("call_id", event.callId);

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
    .select("id, call_id, status, gateway_session_id, meta_accepted_at, callback_nonces, stage_timings")
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

  // Safe timing telemetry from the media plane (no SDP, no candidates).
  if (decision.outcome === "answered" || decision.outcome === "terminated" || decision.outcome === "failed") {
    const marks: CallTimings = {};
    if (decision.outcome === "answered") {
      marks.media_ready_at = decision.patch["media_ready_at"] as string;
      if ((payload.inbound_packets ?? 0) > 0) marks.first_inbound_rtp_at = payload.timestamp;
      if ((payload.outbound_packets ?? 0) > 0) marks.first_outbound_rtp_at = payload.timestamp;
    } else {
      marks.terminate_received_at = payload.timestamp;
    }
    decision.patch["stage_timings"] = mergeCallTimings(
      (data as { stage_timings?: unknown } | null)?.stage_timings,
      marks,
    );
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
