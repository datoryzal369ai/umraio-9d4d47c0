import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { TASK_KINDS } from "./executive-ai.server";
import { createTask, executeTask } from "./task-engine.server";

export const runExecutiveTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: string; brief?: string }) => {
    if (!input?.kind || !TASK_KINDS[input.kind]) throw new Error("Unknown task kind");
    return { kind: input.kind, brief: (input.brief ?? "").slice(0, 2000) };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: profile } = await supabase
      .from("profiles")
      .select("agency_id")
      .eq("id", userId)
      .maybeSingle();
    const agencyId = profile?.agency_id as string | undefined;
    if (!agencyId) throw new Error("No agency found for this account");

    const taskId = await createTask(supabase, agencyId, {
      kind: data.kind,
      brief: data.brief,
      origin: "manual",
      createdBy: userId,
    });
    const status = await executeTask(supabase, agencyId, taskId);
    return { taskId, status };
  });


export const decideExecutiveTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { taskId: string; decision: "approve" | "reject" }) => {
    if (!input?.taskId) throw new Error("taskId is required");
    if (input.decision !== "approve" && input.decision !== "reject")
      throw new Error("Invalid decision");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: task, error } = await supabase
      .from("ai_tasks")
      .select("id, agency_id, title, worker_key, kind, status")
      .eq("id", data.taskId)
      .maybeSingle();
    if (error) throw error;
    if (!task) throw new Error("Task not found");
    // Approval governance: only a task that is genuinely pending a human
    // decision may be approved or rejected. This blocks re-approval of an
    // already decided action and prevents duplicate side effects.
    if (task.status !== "waiting_approval")
      throw new Error(
        `This action is no longer awaiting approval (current state: ${task.status}).`,
      );


    // Record the human decision first — compare-and-set on `waiting_approval`
    // so two concurrent approvals cannot both execute the same action.
    const { data: claimed } = await supabase
      .from("ai_tasks")
      .update({
        status: data.decision === "approve" ? "running" : "rejected",
        approved_at: data.decision === "approve" ? new Date().toISOString() : null,
        approved_by: data.decision === "approve" ? userId : null,
      })
      .eq("id", task.id)
      .eq("status", "waiting_approval")
      .select("id");
    if (!claimed || claimed.length === 0)
      throw new Error("This action was already decided by someone else.");


    await supabase.from("activity_log").insert({
      agency_id: task.agency_id,
      actor: "human",
      action: `${data.decision === "approve" ? "Approved" : "Rejected"} AI output: ${task.title}`,
      entity: "ai_task",
      entity_id: task.id,
      meta: { worker_key: task.worker_key, kind: task.kind },
    });

    let status = data.decision === "approve" ? "completed" : "rejected";

    if (data.decision === "approve") {
      const { EXECUTIVE_ACTION_KIND, executeApprovedExecutiveAction } = await import(
        "./executive/execution.server"
      );
      if (task.kind === EXECUTIVE_ACTION_KIND) {
        // Real execution: the task only completes if the side effect succeeded.
        const outcome = await executeApprovedExecutiveAction(
          supabase,
          task.agency_id as string,
          task.id as string,
          userId,
        );
        status = outcome.status;
        if (outcome.status === "failed") throw new Error(outcome.detail);
      } else {
        // Document output: approval publishes the already-produced result.
        await supabase
          .from("ai_tasks")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", task.id);
      }
    }

    const { count } = await supabase
      .from("ai_tasks")
      .select("id", { count: "exact", head: true })
      .eq("agency_id", task.agency_id)
      .eq("worker_key", task.worker_key)
      .eq("status", "waiting_approval");

    await supabase
      .from("ai_workers")
      .update({ status: (count ?? 0) > 0 ? "waiting_approval" : "idle" })
      .eq("agency_id", task.agency_id)
      .eq("worker_key", task.worker_key);

    return { status };
  });
