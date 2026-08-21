import { createFileRoute } from "@tanstack/react-router";

import { authorizeCronRequest } from "@/lib/cron-auth.server";

/**
 * Autonomous engine tick. Called on a schedule; runs one observe → plan →
 * execute cycle for every agency. Secured with the project publishable key.
 */
export const Route = createFileRoute("/api/public/hooks/task-engine")({
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
        const { runAutonomousCycle } = await import("@/lib/task-engine.server");

        const { data: agencies, error } = await supabaseAdmin
          .from("agencies")
          .select("id")
          .limit(50);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const results: { agency_id: string; queued?: number; executed?: number; error?: string }[] =
          [];
        for (const agency of agencies ?? []) {
          try {
            const res = await runAutonomousCycle(supabaseAdmin, agency.id);
            results.push({ agency_id: agency.id, queued: res.queued, executed: res.executed.length });
          } catch (err) {
            results.push({
              agency_id: agency.id,
              error: err instanceof Error ? err.message : "cycle failed",
            });
          }
        }

        return Response.json({ ok: true, agencies: results.length, results });
      },
    },
  },
});
