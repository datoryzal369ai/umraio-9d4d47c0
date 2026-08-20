import { createFileRoute, Link, redirect, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, Check, Loader2, Play, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app/PageHeader";
import { useCopy } from "@/lib/i18n/dict";
import { EXECUTIVE_DICT } from "@/lib/i18n/app/executive.i18n";
import { WhatsappExecutiveCard } from "@/components/dashboard/WhatsappExecutiveCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  STATUS_LABEL,
  STATUS_TONE,
  WORKER_TASKS,
  fetchTasks,
  fetchWorkers,
  type AiTask,
  type WorkerStatus,
} from "@/lib/executive";
import { decideExecutiveTask, runExecutiveTask } from "@/lib/executive-ai.functions";
import { WorkforceNavigator } from "@/components/executive/WorkforceNavigator";
import { relativeTime } from "@/components/executive/WorkforceGrid";
import {
  AUTONOMY_TONE,
  RUNTIME_TONE,
  deriveWorkerRuntime,
} from "@/lib/executive/worker-state";
import { EXECUTIVE_CENTER_DICT } from "@/lib/i18n/app/executive-center.i18n";
import { fetchEngineTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/executive/$workerKey")({
  // Workers with a dedicated workspace route are redirected to it.
  beforeLoad: ({ params }) => {
    if (params.workerKey === "sales_elite") {
      throw redirect({ to: "/sales-elite" });
    }
  },
  head: () => ({

    meta: [
      { title: "AI Worker — UMRAIO AI Executive Center" },
      {
        name: "description",
        content:
          "Run, review and approve the work of a single UMRAIO AI worker: campaigns, content, lead intelligence and WhatsApp follow-ups.",
      },
      { property: "og:title", content: "AI Worker — UMRAIO AI Executive Center" },
      {
        property: "og:description",
        content: "Assign tasks to your AI worker and approve its output.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WorkerDetail,
});

function WorkerDetail() {
  const copy = useCopy(EXECUTIVE_DICT).workerDetail;
  const { workerKey } = useParams({ from: "/_authenticated/executive/$workerKey" });
  const queryClient = useQueryClient();
  const [brief, setBrief] = useState("");
  const [running, setRunning] = useState<string | null>(null);

  const runTask = useServerFn(runExecutiveTask);
  const decideTask = useServerFn(decideExecutiveTask);

  const workers = useQuery({ queryKey: ["ai-workers"], queryFn: fetchWorkers });
  const tasks = useQuery({
    queryKey: ["ai-tasks", workerKey],
    queryFn: () => fetchTasks(workerKey),
  });

  const engine = useQuery({ queryKey: ["engine-tasks"], queryFn: () => fetchEngineTasks(120) });
  const center = useCopy(EXECUTIVE_CENTER_DICT);

  const worker = (workers.data ?? []).find((w) => w.worker_key === workerKey);
  const runtime = worker ? deriveWorkerRuntime(worker, engine.data ?? []) : null;
  const status = (worker?.is_enabled ? worker.status : "idle") as WorkerStatus;

  const runMutation = useMutation({
    mutationFn: (kind: string) => runTask({ data: { kind, brief } }),
    onMutate: (kind) => setRunning(kind),
    onSuccess: () => {
      toast.success(copy.toastTaskFinished);
      setBrief("");
      queryClient.invalidateQueries({ queryKey: ["ai-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["ai-workers"] });
      queryClient.invalidateQueries({ queryKey: ["ai-metrics"] });
      queryClient.invalidateQueries({ queryKey: ["ai-activity"] });
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setRunning(null),
  });

  const decideMutation = useMutation({
    mutationFn: (vars: { taskId: string; decision: "approve" | "reject" }) =>
      decideTask({ data: vars }),
    onSuccess: (_res, vars) => {
      toast.success(vars.decision === "approve" ? copy.toastApproved : copy.toastRejected);
      queryClient.invalidateQueries({ queryKey: ["ai-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["ai-workers"] });
      queryClient.invalidateQueries({ queryKey: ["ai-activity"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function toggleEnabled() {
    if (!worker) return;
    const { error } = await supabase
      .from("ai_workers")
      .update({ is_enabled: !worker.is_enabled })
      .eq("id", worker.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["ai-workers"] });
  }

  const availableTasks = WORKER_TASKS[workerKey] ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <WorkforceNavigator workerKey={workerKey} currentName={worker?.name} />

      <PageHeader
        eyebrow={copy.eyebrow}
        title={worker?.name ?? copy.fallbackTitle}
        description={worker?.description ?? copy.fallbackDescription}
        actions={
          worker ? (
            <div className="flex flex-wrap items-center gap-2">
              {runtime ? (
                <>
                  <Badge className={cn("border-0", RUNTIME_TONE[runtime.state])}>
                    {center.runtime[runtime.state]}
                  </Badge>
                  <span
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
                      AUTONOMY_TONE[runtime.autonomy],
                    )}
                  >
                    {center.autonomyValue[runtime.autonomy]}
                  </span>
                </>
              ) : (
                <Badge className={cn("border-0", STATUS_TONE[status])}>{STATUS_LABEL[status]}</Badge>
              )}
              <Button size="sm" variant="outline" onClick={toggleEnabled}>
                {worker.is_enabled ? copy.pauseWorker : copy.activateWorker}
              </Button>
            </div>
          ) : null
        }
      />

      {runtime ? (
        <section className="panel grid gap-4 p-5 sm:grid-cols-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {center.activeTaskLabel}
            </p>
            <p className="mt-1 truncate text-sm">
              {runtime.activeTask ? runtime.activeTask.title : center.noActiveTask}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {center.lastExecutionLabel}
            </p>
            <p className="mt-1 truncate text-sm">
              {runtime.lastExecutionAt
                ? relativeTime(runtime.lastExecutionAt)
                : center.neverExecuted}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {center.approvalLabel}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {runtime.autonomy === "paused"
                ? center.pausedNote
                : runtime.autonomy === "autonomous"
                  ? center.autonomousNote
                  : center.approvalRequiredNote}
            </p>
          </div>
        </section>
      ) : null}


      {workerKey === "whatsapp" ? <WhatsappExecutiveCard /> : null}

      <section className="panel space-y-4 p-5">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-border/60 bg-surface p-2">
            <Bot className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold">{copy.assignTaskTitle}</h2>
            <p className="text-xs text-muted-foreground">
              {copy.assignTaskDescription}
            </p>
          </div>
        </div>

        <Textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          rows={3}
          placeholder={copy.briefPlaceholder}
          aria-label={copy.briefAriaLabel}
        />

        <div className="flex flex-wrap gap-2">
          {availableTasks.map((task) => (
            <Button
              key={task.kind}
              size="sm"
              disabled={runMutation.isPending || worker?.is_enabled === false}
              onClick={() => runMutation.mutate(task.kind)}
            >
              {running === task.kind ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {task.label}
            </Button>
          ))}
        </div>
        {worker?.is_enabled === false ? (
          <p className="text-xs text-muted-foreground">
            {copy.workerPausedNotice}
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">{copy.taskHistoryTitle}</h2>
        {tasks.isLoading ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : (tasks.data ?? []).length === 0 ? (
          <p className="panel p-6 text-center text-sm text-muted-foreground">
            {copy.noTasksForWorker}
          </p>
        ) : (
          (tasks.data ?? []).map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onDecide={(decision) => decideMutation.mutate({ taskId: task.id, decision })}
              deciding={decideMutation.isPending}
            />
          ))
        )}
      </section>
    </div>
  );
}

function TaskCard({
  task,
  onDecide,
  deciding,
}: {
  task: AiTask;
  onDecide: (decision: "approve" | "reject") => void;
  deciding: boolean;
}) {
  const copy = useCopy(EXECUTIVE_DICT).workerDetail;
  const [open, setOpen] = useState(false);
  const sections = task.output?.sections ?? [];

  return (
    <article className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{task.title}</h3>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {task.status.replace("_", " ")}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {task.summary ?? task.error ?? copy.processing}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {new Date(task.created_at).toLocaleString()} · {copy.savesMinutes(task.minutes_saved)}
          </p>
        </div>
        {task.status === "waiting_approval" ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={deciding} onClick={() => onDecide("approve")}>
              <Check className="size-4" />
              {copy.approve}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={deciding}
              onClick={() => onDecide("reject")}
            >
              <X className="size-4" />
              {copy.reject}
            </Button>
          </div>
        ) : null}
      </div>

      {sections.length > 0 ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 -ml-2"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? copy.hideOutput : copy.viewOutput(sections.length)}
          </Button>
          {open ? (
            <div className="mt-3 space-y-4 rounded-xl border border-border/60 bg-surface p-4">
              {sections.map((section, index) => (
                <div key={`${task.id}-${index}`}>
                  <h4 className="text-sm font-semibold">{section.heading}</h4>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {section.body}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
