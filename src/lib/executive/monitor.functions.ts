import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import type { OutcomeFinding } from "@/lib/executive/outcome.core";

/**
 * Exposes the existing server-side `monitorExecutedDecisions` intelligence to
 * the Executive Center. Read-only: it classifies real business outcomes for
 * already-executed executive actions and never mutates or fabricates state.
 */
export const getOutcomeMonitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OutcomeFinding[]> => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const { supabase, userId } = context as any;

    const { data: profile } = await supabase
      .from("profiles")
      .select("agency_id")
      .eq("id", userId)
      .maybeSingle();
    const agencyId = profile?.agency_id as string | undefined;
    if (!agencyId) return [];

    const { monitorExecutedDecisions } = await import("./execution.server");
    return (await monitorExecutedDecisions(supabase, agencyId)) as OutcomeFinding[];
  });
