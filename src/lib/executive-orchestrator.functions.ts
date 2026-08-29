import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */

async function resolveAgencyId(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  const agencyId = profile?.agency_id as string | undefined;
  if (!agencyId) throw new Error("No agency found for this account");
  return agencyId;
}

/**
 * Manual orchestration cycle. Uses the exact same governed engine as the
 * scheduled autonomous cycle — only `trigger_type` differs.
 */
export const runExecutiveCycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { runGovernedCycle } = await import("./executive-autonomy.server");
    return await runGovernedCycle(supabase, agencyId, { triggerType: "manual", userId });
  });

/** Authorised agency user sets the autonomy mode (kill switch). */
export const setAutonomyMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { mode: "off" | "assisted" | "autonomous" }) => {
    if (!["off", "assisted", "autonomous"].includes(input?.mode))
      throw new Error("Invalid autonomy mode");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { error } = await supabase
      .from("agency_settings")
      .update({ autonomy_mode: data.mode })
      .eq("agency_id", agencyId);
    if (error) throw new Error(error.message);

    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "human",
      actor_user_id: userId,
      action: `AI autonomy mode set to ${data.mode.toUpperCase()}`,
      entity: "agency_settings",
      entity_id: null,
      meta: { autonomy_mode: data.mode, user_id: userId },
    });

    return { mode: data.mode };
  });
