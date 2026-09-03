/**
 * UMRAIO® — inbound call critical-path stage timings (pure, deterministic).
 *
 * Records only safe, non-sensitive wall-clock marks for the answer critical
 * path. No SDP, no candidates, no credentials — timestamps and durations only.
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
  "first_inbound_rtp_at",
  "first_outbound_rtp_at",
  "media_ready_at",
  "terminate_received_at",
] as const;

export type CallTimingStage = (typeof CALL_TIMING_STAGES)[number];

export type CallTimings = Partial<Record<CallTimingStage, string>> & {
  durations_ms?: Record<string, number>;
};

/** Stage pairs whose elapsed time is reported alongside the marks. */
const DURATION_PAIRS: [string, CallTimingStage, CallTimingStage][] = [
  ["tenant_resolution", "webhook_received_at", "tenant_resolved_at"],
  ["gateway_negotiation", "gateway_offer_started_at", "gateway_answer_received_at"],
  ["meta_pre_accept", "meta_pre_accept_started_at", "meta_pre_accept_completed_at"],
  ["pre_accept_to_accept", "meta_pre_accept_completed_at", "meta_accept_started_at"],
  ["meta_accept", "meta_accept_started_at", "meta_accept_completed_at"],
  ["accept_to_media_ready", "meta_accept_completed_at", "media_ready_at"],
  ["webhook_to_pre_accept", "webhook_received_at", "meta_pre_accept_completed_at"],
  ["webhook_to_accept", "webhook_received_at", "meta_accept_completed_at"],
  ["webhook_to_media_ready", "webhook_received_at", "media_ready_at"],
  ["webhook_to_terminate", "webhook_received_at", "terminate_received_at"],
];

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

  mark(stage: CallTimingStage, at?: Date): string {
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

/** Merges new marks onto whatever is already persisted, recomputing durations. */
export function mergeCallTimings(existing: unknown, incoming: CallTimings): CallTimings {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  delete base["durations_ms"];
  const merged: Partial<Record<CallTimingStage, string>> = {};
  for (const stage of CALL_TIMING_STAGES) {
    const incomingValue = incoming[stage];
    const existingValue = base[stage];
    if (typeof incomingValue === "string") merged[stage] = incomingValue;
    else if (typeof existingValue === "string") merged[stage] = existingValue;
  }
  const durations = computeCallDurations(merged);
  const out: CallTimings = { ...merged };
  if (Object.keys(durations).length > 0) out.durations_ms = durations;
  return out;
}
