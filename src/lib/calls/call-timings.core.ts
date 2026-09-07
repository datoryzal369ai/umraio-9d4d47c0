/**
 * UMRAIO® — inbound call critical-path stage timings (pure, deterministic).
 *
 * Records only safe, non-sensitive wall-clock marks for the answer critical
 * path. No SDP, no candidates, no credentials — timestamps and durations only.
 *
 * FIRST WRITE WINS. Every anchor is recorded once, by the first writer that
 * observes it. A later webhook (typically the terminal one) carries its own
 * `webhook_received_at` / `tenant_resolved_at`; merging it must never move
 * the anchors of the original ringing webhook, otherwise every derived
 * duration is silently rewritten.
 */

export const CALL_TIMING_STAGES = [
  "webhook_received_at",
  "tenant_resolved_at",
  "gateway_offer_started_at",
  "gateway_answer_received_at",
  "meta_pre_accept_started_at",
  "meta_pre_accept_completed_at",
  "ice_connected_at",
  "dtls_connected_at",
  "meta_accept_started_at",
  "meta_accept_completed_at",
  "post_accept_notified_at",
  "first_inbound_rtp_at",
  "first_outbound_rtp_at",
  "media_ready_at",
  "meta_terminate_requested_at",
  "meta_terminate_completed_at",
  "terminate_received_at",
] as const;

export type CallTimingStage = (typeof CALL_TIMING_STAGES)[number];

/**
 * Enumerated, non-timestamp lifecycle outcomes persisted next to the marks.
 * Values are short enumerations only — never free text, never PII.
 */
export const CALL_OUTCOME_FIELDS = [
  /** Result of the post-accept greeting notification to the media plane. */
  "post_accept_notify_outcome",
  /** Result of the best-effort Meta terminate after a graceful completion. */
  "meta_terminate_outcome",
  /** Result of writing the call summary into the WhatsApp thread. */
  "call_memory_outcome",
] as const;

export type CallOutcomeField = (typeof CALL_OUTCOME_FIELDS)[number];

export type CallTimings = Partial<Record<CallTimingStage, string>> &
  Partial<Record<CallOutcomeField, string>> & {
    durations_ms?: Record<string, number>;
    /** Explicit, enumerated reason a session failed or was terminated. */
    failure_reason?: string;
  };

/** Stage pairs whose elapsed time is reported alongside the marks. */
const DURATION_PAIRS: [string, CallTimingStage, CallTimingStage][] = [
  ["tenant_resolution", "webhook_received_at", "tenant_resolved_at"],
  ["gateway_negotiation", "gateway_offer_started_at", "gateway_answer_received_at"],
  ["meta_pre_accept", "meta_pre_accept_started_at", "meta_pre_accept_completed_at"],
  ["pre_accept_to_accept", "meta_pre_accept_completed_at", "meta_accept_started_at"],
  ["meta_accept", "meta_accept_started_at", "meta_accept_completed_at"],
  ["accept_to_media_ready", "meta_accept_completed_at", "media_ready_at"],
  ["accept_to_post_accept_notify", "meta_accept_completed_at", "post_accept_notified_at"],
  ["webhook_to_pre_accept", "webhook_received_at", "meta_pre_accept_completed_at"],
  ["webhook_to_accept", "webhook_received_at", "meta_accept_completed_at"],
  ["webhook_to_media_ready", "webhook_received_at", "media_ready_at"],
  ["meta_terminate", "meta_terminate_requested_at", "meta_terminate_completed_at"],
  ["webhook_to_terminate", "webhook_received_at", "terminate_received_at"],
];

const OUTCOME_MAX = 64;

export function computeCallDurations(marks: Partial<Record<CallTimingStage, string>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, from, to] of DURATION_PAIRS) {
    const a = marks[from];
    const b = marks[to];
    if (!a || !b) continue;
    const ms = Date.parse(b) - Date.parse(a);
    if (Number.isFinite(ms)) out[name] = ms;
  }
  return out;
}

/** Mutable collector used along the critical path. */
export class CallTimeline {
  private readonly marks: Partial<Record<CallTimingStage, string>> = {};

  constructor(private readonly clock: () => Date) {}

  /**
   * Records a stage once. A second mark of the same stage is ignored and the
   * ORIGINAL timestamp is returned, so no code path can move an anchor.
   */
  mark(stage: CallTimingStage, at?: Date): string {
    const existing = this.marks[stage];
    if (existing) return existing;
    const iso = (at ?? this.clock()).toISOString();
    this.marks[stage] = iso;
    return iso;
  }

  get(stage: CallTimingStage): string | undefined {
    return this.marks[stage];
  }

  snapshot(): CallTimings {
    const durations = computeCallDurations(this.marks);
    const value: CallTimings = { ...this.marks };
    if (Object.keys(durations).length > 0) value.durations_ms = durations;
    return value;
  }

  /** Flat, log-safe representation of the durations only. */
  logLine(): string {
    const durations = computeCallDurations(this.marks);
    return Object.entries(durations)
      .map(([k, v]) => `${k}_ms=${v}`)
      .join(" ");
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Merges new marks onto whatever is already persisted, recomputing durations.
 * FIRST WRITE WINS for every stage, outcome and the failure reason: a value
 * already persisted is never replaced by a later writer.
 */
export function mergeCallTimings(existing: unknown, incoming: CallTimings): CallTimings {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  delete base["durations_ms"];
  const merged: Partial<Record<CallTimingStage, string>> = {};
  for (const stage of CALL_TIMING_STAGES) {
    const existingValue = readString(base[stage]);
    const incomingValue = readString(incoming[stage]);
    if (existingValue) merged[stage] = existingValue;
    else if (incomingValue) merged[stage] = incomingValue;
  }
  const durations = computeCallDurations(merged);
  const out: CallTimings = { ...merged };
  if (Object.keys(durations).length > 0) out.durations_ms = durations;

  for (const field of CALL_OUTCOME_FIELDS) {
    const existingValue = readString(base[field]);
    const incomingValue = readString(incoming[field]);
    const value = existingValue ?? incomingValue;
    if (value) out[field] = value.slice(0, OUTCOME_MAX);
  }

  const reason = readString(base["failure_reason"]) ?? readString(incoming.failure_reason) ?? "";
  if (reason) out.failure_reason = reason.slice(0, 120);
  return out;
}

/** True when the persisted timings already carry the given stage. */
export function hasCallTimingMark(existing: unknown, stage: CallTimingStage): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  return Boolean(readString((existing as Record<string, unknown>)[stage]));
}
