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
  shouldTerminateAtMeta,
  type CallSessionRow,
  type GatewayCallbackPayload,
} from "./gateway-callback.core";
import {
  isGreetingConfirmed,
  notifyCallAccepted,
  postAcceptNotifyOutcome,
  probeGatewaySpeech,
  requestMediaSession,
  resolveGatewayConfig,
  terminateMediaSession,
} from "./media-gateway.server";
import { metaAcceptCall, metaPreAcceptCall, metaTerminateCall } from "./meta-calls.server";
import { finalizeCallMemory } from "./call-context.server";
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

type DbWriteError = { code?: string | null; message?: string | null } | null | undefined;

function checkCallWrite(result: { error?: DbWriteError } | null | undefined, stage: string): void {
  if (!result?.error) return;
  // Log the stage and code only; database messages can contain row values.
  console.error(`[calls] persistence_failed stage=${stage} code=${result.error.code ?? "unknown"}`);
  throw new Error(`call_persistence_${stage}`);
}

/** Re-read after external work so the next timing write includes committed callback marks. */
async function persistTimingMarks(
  db: Db,
  callId: string,
  stage: string,
  marks: CallTimings,
): Promise<void> {
  const current = await db
    .from("whatsapp_call_sessions")
    .select("stage_timings")
    .eq("call_id", callId)
    .maybeSingle();
  checkCallWrite(current, `${stage}_read`);
  if (!current?.data) return;
  await writeSession(db, callId, stage, {
    stage_timings: mergeCallTimings(current.data.stage_timings, marks),
  });
}

/**
 * One call-session write on the critical path. Database errors are NEVER
 * swallowed: they are logged (stage + code, never row content) and reported to
 * the caller, which decides whether the call can continue. It never throws.
 * `critical` writes get exactly one immediate retry — the `meta_accepted_at`
 * anchor, for instance, is what later lets `media_ready` become `answered`.
 */
async function writeSession(
  db: Db,
  callId: string,
  stage: string,
  patch: Record<string, unknown>,
  options: { critical?: boolean } = {},
): Promise<boolean> {
  const attempts = options.critical ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let error: DbWriteError = null;
    try {
      const result = (await db.from("whatsapp_call_sessions").update(patch).eq("call_id", callId)) as
        | { error?: DbWriteError }
        | null
        | undefined;
      error = result?.error ?? null;
    } catch (thrown) {
      error = { code: (thrown as Error)?.name ?? "exception", message: (thrown as Error)?.message ?? null };
    }
    if (!error) return true;
    console.error(
      `[calls] session_write_failed call_id=${callId} stage=${stage} attempt=${attempt}/${attempts} code=${error.code ?? "unknown"} critical=${Boolean(options.critical)}`,
    );
  }
  return false;
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
    // FIRST WRITE WINS: the original ringing webhook's anchors survive; only
    // the genuinely new `terminate_received_at` mark is added.
    statusPatch["stage_timings"] = mergeCallTimings(existing.stage_timings, timeline.snapshot());
  }
  const written = await writeSession(db, event.callId, `webhook_${event.status}`, statusPatch, {
    critical: terminal,
  });
  console.log(
    `[calls] call_state_transition call_id=${event.callId} from=${existing.status} to=${event.status} reason=${event.terminationReason ?? "none"} persisted=${written}`,
  );

  // A caller who hangs up mid-negotiation must not leave media running.
  if (terminal) {
    const gateway = resolveGatewayConfig(env);
    if (gateway && LIVE_STATUSES.has(existing.status)) {
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
    // CALL → TEXT continuity: flush whatever RAIŌ learned into the SAME
    // WhatsApp thread the moment the call ends, including a mid-call hang-up.
    // The outcome is enumerated and recorded — never silently dropped.
    const memoryOutcome = await finalizeCallMemory(db, { callId: event.callId }).catch(() => "threw" as const);
    if (memoryOutcome.endsWith("_failed") || memoryOutcome === "threw") {
      await writeSession(db, event.callId, "call_memory_outcome", {
        stage_timings: mergeCallTimings(statusPatch["stage_timings"] ?? existing.stage_timings, {
          call_memory_outcome: memoryOutcome,
        }),
      });
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
  if (timings) patch["stage_timings"] = mergeCallTimings(timings, { failure_reason: reason });
  await writeSession(db, callId, `failed_${reason}`, patch, { critical: true });
}

/** Statuses in which media negotiation is (or may be) in flight. */
const NEGOTIATION_STATUSES = new Set([
  "answer_requested",
  "media_negotiating",
  "meta_pre_accepted",
]);

/**
 * Every non-terminal state in which media may be running. A caller hang-up in
 * ANY of these must tear the media session down — including "answered", which
 * previously kept the gateway session alive until its 600s reaper.
 */
const LIVE_STATUSES = new Set([...NEGOTIATION_STATUSES, "answered"]);

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

  await writeSession(db, event.callId, "answer_requested", {
    status: "answer_requested",
    answer_requested_at: nowIso,
  });
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

  await writeSession(
    db,
    event.callId,
    "media_negotiating",
    {
      status: "media_negotiating",
      gateway_session_id: media.sessionId,
      media_negotiated_at: now().toISOString(),
      stage_timings: timeline.snapshot(),
    },
    { critical: true },
  );
  console.log(`[calls] media_negotiating call_id=${event.callId} session_id=${media.sessionId}`);

  if (!tenant.accessToken) {
    await teardown("meta_token_missing");
    await markFailed(db, event.callId, "meta_token_missing", now().toISOString(), timeline.snapshot());
    return "negotiation_failed";
  }

  const cancelled = async (phase: string): Promise<CallHandlingOutcome> => {
    console.log(`[calls] answer_cancelled call_id=${event.callId} phase=${phase} reason=call_terminated`);
    await teardown("call_terminated");
    // The terminal webhook already merged its marks; ours are added underneath
    // (first write wins) so neither side loses an anchor.
    const { data: current } = await db
      .from("whatsapp_call_sessions")
      .select("stage_timings")
      .eq("call_id", event.callId)
      .maybeSingle();
    await writeSession(db, event.callId, `cancelled_${phase}`, {
      stage_timings: mergeCallTimings(current?.stage_timings, timeline.snapshot()),
    });
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
    // Schema contract: `meta_pre_accepted` is an accepted session status
    // (widening migration 2026-09). A failed write is logged, never fatal —
    // the accept path continues so the caller is not dropped over telemetry.
    const persisted = await writeSession(db, event.callId, "meta_pre_accepted", {
      status: "meta_pre_accepted",
      meta_pre_accepted_at: timeline.get("meta_pre_accept_completed_at"),
      stage_timings: timeline.snapshot(),
    });
    console.log(`[calls] meta_pre_accept_ok call_id=${event.callId} persisted=${persisted}`);
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

  // CRITICAL anchor: without `meta_accepted_at` the later `media_ready`
  // callback is rejected (`media_ready_without_meta_accept`) and the call can
  // never become `answered`. One retry, and a loud log if it still fails.
  const acceptPersisted = await writeSession(
    db,
    event.callId,
    "meta_accepted",
    {
      meta_accepted_at: timeline.get("meta_accept_completed_at"),
      stage_timings: timeline.snapshot(),
    },
    { critical: true },
  );
  console.log(
    `[calls] meta_accept_ok call_id=${event.callId} awaiting=media_ready pre_accept=${preAccepted.ok} persisted=${acceptPersisted} ${timeline.logLine()}`,
  );
  if (!acceptPersisted) {
    console.error(
      `[calls] meta_accept_anchor_missing call_id=${event.callId} effect=media_ready_will_be_rejected action=inspect_database`,
    );
  }

  // 4) Post-accept notification. Exactly one greeting is started by the
  //    gateway here — never earlier (the turn endpoint rejects a call Meta has
  //    not accepted) and never again (the gateway keeps it idempotent). A
  //    TERMINATE that already closed the media session yields "closed".
  //    SUCCESS IS CONFIRMED, NOT ASSUMED: `post_accept_notified_at` is only
  //    recorded when the gateway reports the greeting started (or had already
  //    started); every other outcome is persisted as an enumerated outcome.
  const notified = await notifyCallAccepted({
    gatewayUrl: gateway.url,
    secret: gateway.secret,
    callId: event.callId,
    agencyId: tenant.agencyId,
    phoneNumberId,
    now: now(),
    ...fetchOpt,
  });
  const notifyOutcome = postAcceptNotifyOutcome(notified);
  const greetingConfirmed = isGreetingConfirmed(notified);
  if (greetingConfirmed) timeline.mark("post_accept_notified_at");
  console.log(
    `[calls] post_accept_notify call_id=${event.callId} ok=${notified.ok} confirmed=${greetingConfirmed} outcome=${notifyOutcome}`,
  );
  // Speech ownership guard: the Worker control plane cannot encode Opus, so a
  // media plane without the speech capability produces a SILENT accepted call
  // (the caller sees "No answer"). Make that deployment mismatch loud.
  if (env["CALL_TTS_IN_WORKER"] !== "1") {
    const speech = await probeGatewaySpeech({
      gatewayUrl: gateway.url,
      ...fetchOpt,
    });
    if (speech !== "up") {
      console.log(
        `[calls] gateway_speech_unavailable call_id=${event.callId} speech=${speech} action=redeploy_media_plane`,
      );
    }
  }

  const notifyMarks: CallTimings = { post_accept_notify_outcome: notifyOutcome };
  const notifiedAt = timeline.get("post_accept_notified_at");
  if (greetingConfirmed && notifiedAt) notifyMarks.post_accept_notified_at = notifiedAt;
  // Telemetry cannot cancel an accepted call. Persistence failures are logged.
  await persistTimingMarks(db, event.callId, "post_accept_notify", notifyMarks).catch(
    () => undefined,
  );

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
  fetchImpl?: typeof fetch;
}): Promise<GatewayCallbackOutcome> {
  const { db, payload } = args;
  const now = args.now ?? (() => new Date());

  const loaded = await db
    .from("whatsapp_call_sessions")
    .select(
      "id, call_id, status, gateway_session_id, meta_accepted_at, callback_nonces, stage_timings, agency_id, phone_number_id",
    )
    .eq("call_id", payload.call_id)
    .maybeSingle();
  checkCallWrite(loaded, "callback_read");
  const data = loaded?.data;

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
      // Every failed/terminated session carries an explicit reason.
      marks.failure_reason =
        payload.reason && payload.reason.trim()
          ? payload.reason.trim()
          : decision.outcome === "failed"
            ? "media_failed_unspecified"
            : "terminated_unspecified";
    }
    decision.patch["stage_timings"] = mergeCallTimings(session!.stage_timings, marks);
  }

  // Graceful completion (RAIŌ said goodbye) → ask Meta to hang up so the
  // caller's phone ends the call now. The request marker is written in the
  // SAME transition write, so a duplicate callback (rejected upstream as
  // `session_terminal`) or a re-read of the row can never issue it twice.
  const terminateAtMeta = shouldTerminateAtMeta({
    outcome: decision.outcome,
    reason: payload.reason,
    session: session!,
  });
  if (terminateAtMeta) {
    decision.patch["stage_timings"] = mergeCallTimings(decision.patch["stage_timings"] ?? session!.stage_timings, {
      meta_terminate_requested_at: now().toISOString(),
    });
  }

  // Claim the state that was validated. A concurrent terminal webhook cannot
  // be revived, and only one graceful-completion callback may claim teardown.
  let query = db
    .from("whatsapp_call_sessions")
    .update(decision.patch)
    .eq("id", session!.id)
    .eq("status", session!.status);
  if (decision.requireNullGatewaySession) query = query.is("gateway_session_id", null);
  const written = await query.select("id").maybeSingle();
  if (written?.error) {
    // Surface to the HTTP layer as a retryable failure: the gateway re-sends
    // the event and the state machine re-evaluates it against the real row.
    console.error(
      `[calls] session_write_failed call_id=${payload.call_id} stage=callback_${payload.event} code=${written.error.code ?? "unknown"} critical=true`,
    );
    throw new Error("session_write_failed");
  }
  if (!written?.data) {
    const current = await db
      .from("whatsapp_call_sessions")
      .select("status")
      .eq("id", session!.id)
      .maybeSingle();
    checkCallWrite(current, "callback_conflict_read");
    if (current?.data && isTerminalCallStatus(current.data.status)) {
      return { applied: false, rejection: "concurrent_state_change" };
    }
    // A nonterminal transition may have won (for example, ready versus failed).
    // Use the existing HTTP 500 retry path instead of consuming the losing event.
    throw new Error("call_persistence_concurrent_state_change");
  }
  console.log(
    `[calls] gateway_callback_applied call_id=${payload.call_id} event=${payload.event} outcome=${decision.outcome}`,
  );

  if (terminateAtMeta) {
    await terminateCallAtMeta({
      db,
      session: session!,
      now,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
  }

  return { applied: true, outcome: decision.outcome };
}

/**
 * Best-effort Meta terminate after a GRACEFUL completion. Uses only the
 * tenant credentials the Worker resolves itself from the session's
 * phone_number_id (never anything gateway-supplied). Failure here never
 * changes call state — Meta's own TERMINATE webhook stays authoritative.
 */
async function terminateCallAtMeta(args: {
  db: Db;
  session: CallSessionRow;
  now: () => Date;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { db, session, now } = args;
  const callId = session.call_id;
  let outcome = "skipped:tenant_unresolved";
  try {
    const phoneNumberId = session.phone_number_id ?? null;
    const tenant = phoneNumberId ? await resolveTenant(db, phoneNumberId) : null;
    if (!tenant || (session.agency_id && tenant.agencyId !== session.agency_id)) {
      outcome = "skipped:tenant_unresolved";
    } else if (!tenant.accessToken) {
      outcome = "skipped:meta_token_missing";
    } else {
      const result = await metaTerminateCall({
        phoneNumberId: phoneNumberId!,
        accessToken: tenant.accessToken,
        callId,
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      });
      outcome = result.ok ? "ok" : `failed:${result.reason}`;
    }
  } catch (error) {
    outcome = `failed:${(error as Error)?.name ?? "exception"}`;
  }
  console.log(`[calls] meta_terminate call_id=${callId} reason=conversation_complete outcome=${outcome}`);
  await persistTimingMarks(db, callId, "meta_terminate", {
    meta_terminate_completed_at: now().toISOString(),
    meta_terminate_outcome: outcome,
  }).catch(() => undefined);
}
