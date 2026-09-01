/**
 * UMRAIO® Developer Technical Operations Console — server functions (V1).
 *
 * Deny by default: every function requires an authenticated session AND an
 * explicit row in the Founder-controlled `developer_access` allow-list, read
 * through the caller's own RLS-scoped client (never from client input).
 *
 * Developer authorization is completely independent from agency membership and
 * grants ZERO Founder HQ authority. Responses are allow-listed diagnostic
 * shapes only: no customer data, no secrets, no proprietary internals.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BUILD_IDENTITY } from "@/lib/build-identity";
import {
  DEVELOPER_SECURITY_INDICATORS,
  DEVELOPER_TASKS,
  DEVELOPER_VALIDATION_SNAPSHOT,
  describeEnvPresence,
  integration,
  sanitizeErrorEntry,
  type DevIntegration,
  type DevJobStats,
} from "./developer.core";

export const DEVELOPER_FORBIDDEN_MESSAGE = "Forbidden: developer access required";

/**
 * Server-side developer authorization. Reads the caller's own allow-list row
 * via their RLS-scoped client; a non-developer sees no row and is denied.
 */
async function assertDeveloper(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("developer_access")
    .select("user_id")
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1);

  if (error || !data || data.length === 0) {
    throw new Error(DEVELOPER_FORBIDDEN_MESSAGE);
  }
}

function envRead(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** Whether the caller is on the developer allow-list (UI shaping only). */
export const getDeveloperAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    try {
      await assertDeveloper(supabase as never, userId);
      return { developer: true as const };
    } catch {
      return { developer: false as const };
    }
  });

/**
 * Full read-only technical operations snapshot. Developer allow-list only.
 */
export const getDeveloperConsole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertDeveloper(supabase as never, userId);

    const generatedAt = new Date().toISOString();

    /* ---------------- A. System health ---------------- */
    const dbStart = Date.now();
    const probe = await (supabase as never as { from: (t: string) => any })
      .from("developer_access")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", userId);
    const dbLatencyMs = Date.now() - dbStart;
    const dbOk = !probe?.error;

    const health = {
      application: "healthy" as const,
      backend: dbOk ? ("healthy" as const) : ("error" as const),
      database: dbOk ? ("healthy" as const) : ("error" as const),
      databaseLatencyMs: dbLatencyMs,
      timestamp: generatedAt,
    };

    /* ---------------- B. Build / deployment ---------------- */
    const build = {
      ok: BUILD_IDENTITY.ok,
      environment: BUILD_IDENTITY.environment,
      commitShort: BUILD_IDENTITY.commit_short,
      commitSha: BUILD_IDENTITY.commit_sha,
      buildTime: BUILD_IDENTITY.build_time,
      version: BUILD_IDENTITY.version,
      deployment: BUILD_IDENTITY.environment === "production" ? "published" : "preview",
    };

    /* ---------------- C. Validation ---------------- */
    const validation = { ...DEVELOPER_VALIDATION_SNAPSHOT };

    /* ---------------- D. Integration health ---------------- */
    const { describeAiConfig } = await import("@/lib/ai/config.server");
    let ai: DevIntegration;
    let asr: DevIntegration;
    let tts: DevIntegration;
    try {
      const cfg = describeAiConfig();
      ai = integration(
        "ai_gateway",
        "AI gateway",
        cfg.credentialsConfigured,
        cfg.credentialsConfigured
          ? `Provider ${cfg.provider} reachable configuration.`
          : "Provider credentials not configured.",
      );
      asr = integration(
        "asr",
        "Speech recognition (ASR)",
        Boolean(cfg.audio?.ok),
        cfg.audio?.primary ? `Primary audio provider: ${cfg.audio.primary}.` : "No audio provider resolved.",
      );
      tts = integration(
        "tts",
        "Speech synthesis (TTS)",
        Boolean(envRead("VOICE_TTS_ENGINE")) || Boolean(cfg.audio?.ok),
        envRead("VOICE_TTS_ENGINE")
          ? `Engine selection configured.`
          : "Falling back to default speech engine.",
      );
    } catch (error) {
      const cls = error instanceof Error ? error.name : "UnknownError";
      ai = integration("ai_gateway", "AI gateway", false, `Configuration error (${cls}).`);
      asr = integration("asr", "Speech recognition (ASR)", false, `Configuration error (${cls}).`);
      tts = integration("tts", "Speech synthesis (TTS)", false, `Configuration error (${cls}).`);
    }

    const integrations: DevIntegration[] = [
      integration(
        "whatsapp",
        "WhatsApp Cloud API",
        Boolean(envRead("WHATSAPP_APP_SECRET")) && Boolean(envRead("WHATSAPP_VERIFY_TOKEN")),
        "Webhook signature and verify token configuration.",
      ),
      integration(
        "stripe",
        "Stripe billing",
        Boolean(envRead("STRIPE_SECRET_KEY")),
        "Billing credentials configuration.",
      ),
      ai,
      integration(
        "minimax",
        "MiniMax voice",
        Boolean(envRead("MINIMAX_TTS_API_KEY")) || Boolean(envRead("MINIMAX_API_KEY")),
        "MiniMax voice credentials configuration.",
      ),
      asr,
      tts,
    ];

    /* ---------------- E/F. Operational telemetry (counts only) ---------------- */
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const nowIso = new Date().toISOString();
    const stuckBefore = new Date(Date.now() - 30 * 60_000).toISOString();

    const [
      queuedJobs,
      retryJobs,
      stuckJobs,
      lastJob,
      queuedTasks,
      failedTasks,
      lastTask,
      failedRows,
    ] = await Promise.all([
      supabaseAdmin.from("followup_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabaseAdmin.from("followup_jobs").select("id", { count: "exact", head: true }).gt("attempts", 0),
      supabaseAdmin
        .from("followup_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .lt("run_at", stuckBefore),
      supabaseAdmin
        .from("followup_jobs")
        .select("dispatched_at")
        .not("dispatched_at", "is", null)
        .order("dispatched_at", { ascending: false })
        .limit(1),
      supabaseAdmin.from("ai_tasks").select("id", { count: "exact", head: true }).eq("status", "queued"),
      supabaseAdmin.from("ai_tasks").select("id", { count: "exact", head: true }).eq("status", "failed"),
      supabaseAdmin
        .from("ai_tasks")
        .select("completed_at")
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("ai_tasks")
        .select("id, created_at, error")
        .eq("status", "failed")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    const jobs: DevJobStats[] = [
      {
        jobType: "followup_dispatch",
        queueDepth: queuedJobs.count ?? 0,
        retryCount: retryJobs.count ?? 0,
        stuckCount: stuckJobs.count ?? 0,
        lastExecution: (lastJob.data?.[0]?.dispatched_at as string | undefined) ?? null,
      },
      {
        jobType: "ai_task_engine",
        queueDepth: queuedTasks.count ?? 0,
        retryCount: failedTasks.count ?? 0,
        stuckCount: 0,
        lastExecution: (lastTask.data?.[0]?.completed_at as string | undefined) ?? null,
      },
    ];

    const errors = (failedRows.data ?? []).map((row) =>
      sanitizeErrorEntry(row as { id: string; created_at: string; error: string | null }),
    );

    /* ---------------- G/H/I ---------------- */
    return {
      generatedAt: nowIso,
      health,
      build,
      validation,
      integrations,
      errors,
      jobs,
      env: describeEnvPresence(envRead),
      security: DEVELOPER_SECURITY_INDICATORS,
      tasks: DEVELOPER_TASKS,
    };
  });
