import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { TASK_KINDS } from "./executive-ai.server";
import {
  createTask,
  executeTask,
  notify,
  runAutonomousCycle,
} from "./task-engine.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function agencyOf(supabase: any, userId: string) {
  const { data } = await supabase.from("profiles").select("agency_id").eq("id", userId).maybeSingle();
  const agencyId = data?.agency_id as string | undefined;
  if (!agencyId) throw new Error("No agency found for this account");
  return agencyId;
}

export const enqueueTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: string; brief?: string; priority?: string; run?: boolean }) => {
    if (!input?.kind || !TASK_KINDS[input.kind]) throw new Error("Unknown task kind");
    return {
      kind: input.kind,
      brief: (input.brief ?? "").slice(0, 2000),
      priority: (["low", "normal", "high", "critical"].includes(input.priority ?? "")
        ? input.priority
        : "normal") as "low" | "normal" | "high" | "critical",
      run: input.run !== false,
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await agencyOf(supabase, userId);
    const taskId = await createTask(supabase, agencyId, {
      kind: data.kind,
      brief: data.brief,
      priority: data.priority,
      origin: "manual",
      createdBy: userId,
    });
    if (!data.run) return { taskId, status: "queued" as const };
    const status = await executeTask(supabase, agencyId, taskId);
    return { taskId, status };
  });

export const runTaskNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { taskId: string }) => {
    if (!input?.taskId) throw new Error("taskId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await agencyOf(supabase, userId);
    const status = await executeTask(supabase, agencyId, data.taskId);
    return { status };
  });

export const runEngineCycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const agencyId = await agencyOf(supabase, userId);
    return await runAutonomousCycle(supabase, agencyId);
  });

export const decideTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { taskId: string; decision: "approve" | "reject" }) => {
    if (!input?.taskId) throw new Error("taskId is required");
    if (input.decision !== "approve" && input.decision !== "reject") throw new Error("Invalid decision");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: task } = await supabase
      .from("ai_tasks")
      .select("id, agency_id, title, worker_key, steps, kind, status")
      .eq("id", data.taskId)
      .maybeSingle();
    if (!task) throw new Error("Task not found");
    // Approval governance: only a task genuinely pending a human decision can
    // be decided. Blocks re-approving completed/rejected/cancelled actions.
    if (task.status !== "waiting_approval")
      throw new Error(
        `This action is no longer awaiting approval (current state: ${task.status}).`,
      );

    const approved = data.decision === "approve";
    const steps = Array.isArray(task.steps) ? task.steps : [];
    steps.push({
      at: new Date().toISOString(),
      status: approved ? "approved" : "rejected",
      note: approved ? "Approved by a human executive" : "Rejected by a human executive",
    });

    // Compare-and-set claim: two concurrent approvals cannot both execute.
    const { data: claimed } = await supabase
      .from("ai_tasks")
      .update({
        status: approved ? "running" : "rejected",
        steps,
        approved_at: approved ? new Date().toISOString() : null,
        approved_by: approved ? userId : null,
        completed_at: approved ? null : new Date().toISOString(),
      })
      .eq("id", task.id)
      .eq("status", "waiting_approval")
      .select("id");
    if (!claimed || claimed.length === 0)
      throw new Error("This action was already decided by someone else.");

    let finalStatus: string = approved ? "completed" : "rejected";
    if (approved) {
      const { EXECUTIVE_ACTION_KIND, executeApprovedExecutiveAction } = await import(
        "./executive/execution.server"
      );
      if (task.kind === EXECUTIVE_ACTION_KIND) {
        // Real side effect — the task only completes if execution succeeded.
        const outcome = await executeApprovedExecutiveAction(
          supabase,
          task.agency_id as string,
          task.id as string,
          userId,
        );
        finalStatus = outcome.status;
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

    await supabase.from("activity_log").insert({
      agency_id: task.agency_id,
      actor: "human",
      action: `${approved ? "Approved" : "Rejected"} AI task: ${task.title}`,
      entity: "ai_task",
      entity_id: task.id,
      meta: { decision: data.decision },
    });

    await notify(supabase, task.agency_id, {
      kind: "approval_decision",
      severity: approved ? "success" : "info",
      title: `${approved ? "Approved" : "Rejected"}: ${task.title}`,
      entity: "ai_task",
      entityId: task.id,
    });

    return { status: finalStatus };
  });

export const cancelTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { taskId: string }) => {
    if (!input?.taskId) throw new Error("taskId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: task } = await supabase
      .from("ai_tasks")
      .select("id, agency_id, title, steps, status")
      .eq("id", data.taskId)
      .maybeSingle();
    if (!task) throw new Error("Task not found");
    if (["completed", "failed", "rejected", "cancelled"].includes(task.status))
      throw new Error("This task can no longer be cancelled");

    const steps = Array.isArray(task.steps) ? task.steps : [];
    steps.push({ at: new Date().toISOString(), status: "cancelled", note: "Cancelled by a human executive" });

    await supabase
      .from("ai_tasks")
      .update({ status: "cancelled", steps, cancelled_at: new Date().toISOString() })
      .eq("id", task.id);

    await supabase.from("activity_log").insert({
      agency_id: task.agency_id,
      actor: "human",
      action: `Cancelled AI task: ${task.title}`,
      entity: "ai_task",
      entity_id: task.id,
      meta: {},
    });

    return { status: "cancelled" as const };
  });

export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ids?: string[] } | undefined) => ({ ids: input?.ids ?? [] }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await agencyOf(supabase, userId);
    let query = supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("agency_id", agencyId)
      .is("read_at", null);
    if (data.ids.length > 0) query = query.in("id", data.ids);
    const { error } = await query;
    if (error) throw error;
    return { ok: true };
  });
