import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveEntitlement, type PlanEntitlement } from "./entitlements.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * UMRAIO® — AI USAGE METERING & QUOTA ENFORCEMENT (Step 6.3).
 *
 * WHAT COUNTS AS AN AI REPLY (single authoritative definition):
 *   One AI-generated, CUSTOMER-FACING response = 1 AI reply.
 *   Nothing else consumes AI reply quota.
 *
 * Explicitly NOT counted as an AI reply:
 *   - database reads, CRM operations, UI rendering, analytics
 *   - deterministic lead scoring / sales-opportunity derivation
 *   - internal model reasoning that produces no customer-facing message
 *     (metered separately as `internal_operation`)
 *   - AI worker tasks (metered separately as `ai_task`)
 *
 * Token counts are recorded only when the provider reports them. Estimated
 * tokens are NEVER stored as real usage — the columns stay NULL instead.
 */

export type UsageCategory =
  | "customer_reply"
  | "internal_operation"
  | "ai_task"
  /**
   * VOICE V1 PREPARATION — one speech-to-text transcription of inbound audio.
   * Metered by DURATION (seconds), not by event count. Nothing emits this
   * category yet: voice processing is not implemented.
   */
  | "voice_transcription";
export type QuotaBucket = "ai_replies" | "ai_tasks" | "voice_minutes" | "none";

export function bucketFor(category: UsageCategory): QuotaBucket {
  if (category === "customer_reply") return "ai_replies";
  if (category === "ai_task") return "ai_tasks";
  if (category === "voice_transcription") return "voice_minutes";
  return "none";
}

export type UsageEventInput = {
  agencyId: string;
  /**
   * Stable identifier for THIS logical model request. Retries of the same
   * request must reuse the same key so usage is never double-counted.
   */
  eventKey: string;
  category: UsageCategory;
  taskType?: string | null;
  operation?: string | null;
  source?: string | null;
  worker?: string | null;
  model?: string | null;
  provider?: string | null;
  correlationId?: string | null;
  success: boolean;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** VOICE V1 PREPARATION — billable audio duration for voice events. */
  durationSeconds?: number | null;
  meta?: Record<string, unknown>;
};

function nullableInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

/** Idempotent: a duplicate `eventKey` is ignored, never counted twice. */
export async function recordUsageEvent(supabase: Db, input: UsageEventInput): Promise<void> {
  const row = {
    agency_id: input.agencyId,
    event_key: input.eventKey,
    category: input.category,
    counts_against: bucketFor(input.category),
    task_type: input.taskType ?? null,
    operation: input.operation ?? null,
    source: input.source ?? null,
    worker: input.worker ?? null,
    model: input.model ?? null,
    provider: input.provider ?? null,
    correlation_id: input.correlationId ?? null,
    success: input.success,
    latency_ms: nullableInt(input.latencyMs),
    input_tokens: nullableInt(input.inputTokens),
    output_tokens: nullableInt(input.outputTokens),
    total_tokens: nullableInt(input.totalTokens),
    duration_seconds: nullableInt(input.durationSeconds),
    meta: input.meta ?? {},
  };

  const { error } = await supabase
    .from("usage_events")
    .upsert(row, { onConflict: "event_key", ignoreDuplicates: true });

  if (error) {
    console.error(`[usage] failed to record event ${input.eventKey}: ${error.message}`);
  }
}

/* ---------------- period helpers ---------------- */

export function currentPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function countBucket(
  supabase: Db,
  agencyId: string,
  bucket: QuotaBucket,
  periodStart: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("agency_id", agencyId)
    .eq("counts_against", bucket)
    .gte("occurred_at", periodStart);
  if (error) throw new Error(`usage metering unavailable: ${error.message}`);
  return count ?? 0;
}

async function countCategory(
  supabase: Db,
  agencyId: string,
  category: UsageCategory,
  periodStart: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("agency_id", agencyId)
    .eq("category", category)
    .gte("occurred_at", periodStart);
  if (error) throw new Error(`usage metering unavailable: ${error.message}`);
  return count ?? 0;
}

/**
 * VOICE V1 PREPARATION — voice is metered by duration, so the voice bucket
 * sums `duration_seconds` instead of counting rows.
 */
async function sumVoiceSeconds(
  supabase: Db,
  agencyId: string,
  periodStart: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("usage_events")
    .select("duration_seconds")
    .eq("agency_id", agencyId)
    .eq("counts_against", "voice_minutes")
    .gte("occurred_at", periodStart)
    .limit(10000);
  if (error) throw new Error(`usage metering unavailable: ${error.message}`);
  return ((data ?? []) as Array<{ duration_seconds: number | null }>).reduce(
    (total, row) => total + (row.duration_seconds ?? 0),
    0,
  );
}

/** Minutes of voice already consumed this calendar month (rounded up). */
export async function voiceMinutesUsed(supabase: Db, agencyId: string): Promise<number> {
  const { start } = currentPeriod();
  return Math.ceil((await sumVoiceSeconds(supabase, agencyId, start)) / 60);
}

/* ---------------- quota enforcement ---------------- */

export const QUOTA_WARNING_MESSAGE =
  "Your UMRAIO® AI usage is approaching this month's limit.";
export const QUOTA_EXCEEDED_MESSAGE =
  "Your monthly AI allowance has been reached. Upgrade your plan or contact the UMRAIO® team to continue.";
export const QUOTA_UNAVAILABLE_MESSAGE =
  "UMRAIO® could not verify your AI usage allowance right now. Please try again shortly.";

export class QuotaError extends Error {
  readonly kind: "exceeded" | "unavailable";
  constructor(kind: "exceeded" | "unavailable") {
    super(kind === "exceeded" ? QUOTA_EXCEEDED_MESSAGE : QUOTA_UNAVAILABLE_MESSAGE);
    this.name = "QuotaError";
    this.kind = kind;
  }
}

export type QuotaDecision = {
  allowed: boolean;
  bucket: QuotaBucket;
  used: number;
  limit: number;
  remaining: number;
  ratio: number;
  warning: boolean;
  plan: PlanEntitlement;
  /**
   * OWNER TEST MODE — true when this call was allowed past an exhausted
   * allowance by the agency owner's temporary test override. Usage counters,
   * plan limits and billing state are unchanged; `used`/`limit` stay truthful.
   */
  overridden?: boolean;

};

function limitFor(plan: PlanEntitlement, bucket: QuotaBucket): number {
  if (bucket === "ai_replies") return plan.aiRepliesPerMonth;
  if (bucket === "ai_tasks") return plan.aiTasksPerMonth;
  if (bucket === "voice_minutes") return plan.voiceMinutesPerMonth;
  return Number.POSITIVE_INFINITY;
}

/**
 * Checked BEFORE any model call. Fails CLOSED: if metering is unavailable we
 * never fall through into unlimited paid AI consumption.
 */
export async function checkQuota(
  supabase: Db,
  agencyId: string,
  category: UsageCategory,
): Promise<QuotaDecision> {
  const bucket = bucketFor(category);
  const { plan } = await resolveEntitlement(supabase, agencyId);

  if (bucket === "none") {
    return {
      allowed: true,
      bucket,
      used: 0,
      limit: Number.POSITIVE_INFINITY,
      remaining: Number.POSITIVE_INFINITY,
      ratio: 0,
      warning: false,
      plan,
    };
  }

  const { start } = currentPeriod();
  const used =
    bucket === "voice_minutes"
      ? Math.ceil((await sumVoiceSeconds(supabase, agencyId, start)) / 60)
      : await countBucket(supabase, agencyId, bucket, start);
  const limit = limitFor(plan, bucket);
  const ratio = limit > 0 ? used / limit : 1;

  return {
    allowed: used < limit,
    bucket,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    ratio,
    warning: ratio >= 0.8,
    plan,
  };
}

/** Throws `QuotaError` instead of returning — for expensive customer-facing calls. */
export async function assertQuota(
  supabase: Db,
  agencyId: string,
  category: UsageCategory,
): Promise<QuotaDecision> {
  let decision: QuotaDecision;
  try {
    decision = await checkQuota(supabase, agencyId, category);
  } catch (error) {
    console.error(
      `[usage] quota check failed for agency ${agencyId}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    throw new QuotaError("unavailable"); // fail closed
  }
  if (!decision.allowed) {
    // OWNER TEST MODE — the ONLY bypass of the allowance gate. It does not
    // change counters, plan or billing, and applies to this agency only.
    if (decision.bucket !== "none" && (await isQuotaOverrideActive(supabase, agencyId, decision.bucket))) {
      console.warn(
        `[usage] owner_test_mode bypass bucket=${decision.bucket} agency=${agencyId} used=${decision.used} limit=${decision.limit}`,
      );
      return { ...decision, allowed: true, overridden: true };
    }
    throw new QuotaError("exceeded");
  }
  return decision;

}

/* ---------------- summaries ---------------- */

export type UsageSummary = {
  plan: {
    code: string;
    label: string;
    aiRepliesPerMonth: number;
    aiTasksPerMonth: number;
    maxAutonomy: string;
    priceNote: string;
  };
  periodStart: string;
  periodEnd: string;
  replies: { used: number; limit: number; remaining: number; ratio: number };
  tasks: { used: number; limit: number; remaining: number; ratio: number };
  internalOperations: number;
  /** VOICE V1 PREPARATION — always 0 until voice processing ships. */
  voice: { usedMinutes: number; limitMinutes: number; remainingMinutes: number };
  daily: Array<{ date: string; replies: number; tasks: number; internal: number }>;
};

/** Lightweight server-side usage summary (monthly totals + last 14 days). */
export async function getUsageSummary(supabase: Db, agencyId: string): Promise<UsageSummary> {
  const { plan } = await resolveEntitlement(supabase, agencyId);
  const { start, end } = currentPeriod();

  const [replies, tasks, internal, voiceSeconds] = await Promise.all([
    countBucket(supabase, agencyId, "ai_replies", start),
    countBucket(supabase, agencyId, "ai_tasks", start),
    countCategory(supabase, agencyId, "internal_operation", start),
    sumVoiceSeconds(supabase, agencyId, start),
  ]);
  const voiceMinutes = Math.ceil(voiceSeconds / 60);

  const since = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);
  const { data: recent } = await supabase
    .from("usage_events")
    .select("category, occurred_at")
    .eq("agency_id", agencyId)
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: true })
    .limit(5000);

  const byDay = new Map<string, { replies: number; tasks: number; internal: number }>();
  for (let i = 0; i < 14; i += 1) {
    const day = new Date(since.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    byDay.set(day, { replies: 0, tasks: 0, internal: 0 });
  }
  for (const row of (recent ?? []) as Array<{ category: UsageCategory; occurred_at: string }>) {
    const day = row.occurred_at.slice(0, 10);
    const entry = byDay.get(day);
    if (!entry) continue;
    if (row.category === "customer_reply") entry.replies += 1;
    else if (row.category === "ai_task") entry.tasks += 1;
    else entry.internal += 1;
  }

  const ratio = (used: number, limit: number) => (limit > 0 ? used / limit : 0);

  return {
    plan: {
      code: plan.code,
      label: plan.label,
      aiRepliesPerMonth: plan.aiRepliesPerMonth,
      aiTasksPerMonth: plan.aiTasksPerMonth,
      maxAutonomy: plan.maxAutonomy,
      priceNote: plan.priceNote,
    },
    periodStart: start,
    periodEnd: end,
    replies: {
      used: replies,
      limit: plan.aiRepliesPerMonth,
      remaining: Math.max(0, plan.aiRepliesPerMonth - replies),
      ratio: ratio(replies, plan.aiRepliesPerMonth),
    },
    tasks: {
      used: tasks,
      limit: plan.aiTasksPerMonth,
      remaining: Math.max(0, plan.aiTasksPerMonth - tasks),
      ratio: ratio(tasks, plan.aiTasksPerMonth),
    },
    internalOperations: internal,
    voice: {
      usedMinutes: voiceMinutes,
      limitMinutes: plan.voiceMinutesPerMonth,
      remainingMinutes: Math.max(0, plan.voiceMinutesPerMonth - voiceMinutes),
    },
    daily: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
  };
}

/* ---------------- voice quota (preparation) ---------------- */

export const VOICE_QUOTA_EXCEEDED_MESSAGE =
  "Your monthly UMRAIO® voice allowance has been reached. Upgrade your plan to keep using voice messages.";

/**
 * VOICE V1 PREPARATION — gate for a FUTURE voice request.
 *
 * Called before any media download or ASR call so paid voice processing can
 * never run past the plan allowance. Fails CLOSED when metering is unavailable.
 * Nothing calls this yet; no voice minutes are consumed today.
 */
export async function assertVoiceQuota(
  supabase: Db,
  agencyId: string,
  requestedSeconds = 0,
): Promise<QuotaDecision> {
  const decision = await assertQuota(supabase, agencyId, "voice_transcription");
  const requestedMinutes = Math.ceil(Math.max(0, requestedSeconds) / 60);
  if (requestedMinutes > decision.remaining) throw new QuotaError("exceeded");
  return decision;
}
