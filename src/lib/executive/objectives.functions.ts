import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import {
  isObjectiveStatus,
  validateObjectiveInput,
  type ExecutiveObjective,
  type ObjectiveInput,
} from "./objectives.core";

const COLUMNS =
  "id, agency_id, created_by, objective_text, parsed_metric, target_quantity, deadline, target_segment, status, created_at, updated_at";

/**
 * Resolve the caller's agency server-side. Tenant scope is never taken from
 * client input — RLS then enforces the same boundary a second time.
 */
async function resolveAgencyId(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  userId: string,
): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  const agencyId = data?.agency_id as string | undefined;
  if (!agencyId) throw new Error("No agency found for this account");
  return agencyId;
}

export const createExecutiveObjective = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ObjectiveInput) => validateObjectiveInput(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { data: row, error } = await supabase
      .from("executive_objectives")
      .insert({ ...data, agency_id: agencyId, created_by: userId, status: "active" })
      .select(COLUMNS)
      .single();
    if (error) throw error;
    return row as unknown as ExecutiveObjective;
  });

export const listExecutiveObjectives = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { data, error } = await supabase
      .from("executive_objectives")
      .select(COLUMNS)
      .eq("agency_id", agencyId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []) as unknown as ExecutiveObjective[];
  });

export const getExecutiveObjective = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("Objective id is required");
    return { id: input.id };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { data: row, error } = await supabase
      .from("executive_objectives")
      .select(COLUMNS)
      .eq("id", data.id)
      .eq("agency_id", agencyId)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("Objective not found");
    return row as unknown as ExecutiveObjective;
  });

export const closeExecutiveObjective = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; status?: "completed" | "closed" }) => {
    if (!input?.id) throw new Error("Objective id is required");
    const status: string = input.status ?? "closed";
    if (!isObjectiveStatus(status) || status === "active")
      throw new Error("Invalid closing status");
    return { id: input.id, status: status as "completed" | "closed" };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgencyId(supabase, userId);

    const { data: row, error } = await supabase
      .from("executive_objectives")
      .update({ status: data.status })
      .eq("id", data.id)
      .eq("agency_id", agencyId)
      .eq("status", "active")
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("Objective is not open, or does not belong to this agency");
    return row as unknown as ExecutiveObjective;
  });
