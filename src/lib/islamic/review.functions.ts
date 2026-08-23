import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { canDecideIslamicReview, type IslamicReviewDecision } from "./review.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function resolveAgency(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  const agencyId = data?.agency_id as string | undefined;
  if (!agencyId) throw new Error("No agency found for this account");
  return agencyId;
}

/** Dedicated Islamic authorization path — never reuses sales approval logic. */
async function requireIslamicApprover(supabase: any, userId: string): Promise<void> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = ((data ?? []) as { role: string }[]).map((r) => r.role);
  if (!canDecideIslamicReview(roles)) {
    throw new Error("You do not have Islamic approval authority for this agency.");
  }
}

export const listIslamicReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgency(supabase, userId);
    const { data: roleRows } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const roles = ((roleRows ?? []) as { role: string }[]).map((r) => r.role);
    const { data, error } = await supabase
      .from("islamic_reviews")
      .select(
        "id, conversation_id, lead_id, question, topic, status, reviewer_id, approved_answer, rejection_reason, amendment_notes, delivery_status, reference, created_at, decided_at",
      )
      .eq("agency_id", agencyId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { reviews: data ?? [], canDecide: canDecideIslamicReview(roles) };
  });

export const decideIslamicReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      reviewId: string;
      decision: IslamicReviewDecision;
      approvedAnswer?: string;
      amendmentNotes?: string;
      rejectionReason?: string;
    }) => {
      if (!input?.reviewId) throw new Error("reviewId is required");
      if (!["approve", "amend", "reject"].includes(input.decision))
        throw new Error("Invalid decision");
      return {
        reviewId: input.reviewId,
        decision: input.decision,
        approvedAnswer: (input.approvedAnswer ?? "").slice(0, 4000),
        amendmentNotes: (input.amendmentNotes ?? "").slice(0, 4000),
        rejectionReason: (input.rejectionReason ?? "").slice(0, 1000),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await resolveAgency(supabase, userId);
    await requireIslamicApprover(supabase, userId);

    // Ownership is verified as the signed-in user (RLS applies) BEFORE any
    // privileged write happens.
    const { data: owned } = await supabase
      .from("islamic_reviews")
      .select("id")
      .eq("id", data.reviewId)
      .eq("agency_id", agencyId)
      .maybeSingle();
    if (!owned?.id) throw new Error("Islamic review not found");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { applyIslamicDecision } = await import("./review.server");
    return await applyIslamicDecision(supabaseAdmin as never, {
      agencyId,
      reviewerId: userId,
      reviewId: data.reviewId,
      decision: data.decision,
      approvedAnswer: data.approvedAnswer,
      amendmentNotes: data.amendmentNotes,
      rejectionReason: data.rejectionReason,
    });
  });
