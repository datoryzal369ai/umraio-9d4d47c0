import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Runs a REAL AI SALES ELITE™ intelligence mission over the agency pipeline. */
export const runSalesIntelligence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: profile } = await supabase
      .from("profiles")
      .select("agency_id")
      .eq("id", userId)
      .maybeSingle();
    const agencyId = profile?.agency_id as string | undefined;
    if (!agencyId) throw new Error("No agency found for this account");

    const { runSalesIntelligenceMission } = await import("./mission.server");
    return await runSalesIntelligenceMission(supabase, agencyId, userId);
  });
