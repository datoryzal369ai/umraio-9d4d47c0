import { createFileRoute } from "@tanstack/react-router";

import { authorizeCronRequest } from "@/lib/cron-auth.server";

/**
 * STEP 4A — scheduled autonomous orchestration tick.
 *
 * Called by pg_cron on a conservative cadence. For every agency whose
 * authorised users set autonomy mode to `autonomous`, it runs exactly one
 * bounded governed cycle through the existing orchestration engine.
 *
 * Secured with the project publishable key (same pattern as the task engine
 * hook). Agency scope is resolved server-side — never from client input.
 */
export const Route = createFileRoute("/api/public/hooks/executive-autonomy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected =
          process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"] ?? "";
        const provided = request.headers.get("apikey") ?? "";
        if (!expected || provided !== expected) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runGovernedCycle } = await import("@/lib/executive-autonomy.server");

        // Only agencies that explicitly enabled autonomous execution.
        const { data: eligible, error } = await supabaseAdmin
          .from("agency_settings")
          .select("agency_id")
          .eq("autonomy_mode", "autonomous")
          .limit(100);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const results: Array<Record<string, unknown>> = [];
        for (const row of eligible ?? []) {
          const agencyId = row.agency_id as string;
          try {
            const outcome = await runGovernedCycle(supabaseAdmin, agencyId, {
              triggerType: "scheduled_autonomous",
            });
            results.push({
              agency_id: agencyId,
              status: outcome.status,
              reason: outcome.status === "skipped" ? outcome.reason : undefined,
              actions_executed:
                outcome.status === "completed" ? outcome.cycle.actionsExecuted : undefined,
            });
          } catch (err) {
            results.push({
              agency_id: agencyId,
              status: "failed",
              error: err instanceof Error ? err.message : "cycle failed",
            });
          }
        }

        return Response.json({ ok: true, agencies: results.length, results });
      },
    },
  },
});
