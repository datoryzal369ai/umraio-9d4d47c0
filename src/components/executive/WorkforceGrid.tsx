import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  MessageSquare,
  Radar,
  Sparkles,
  Target,
} from "lucide-react";

import { WorkerLink } from "@/components/executive/WorkforceNavigator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchWorkers, type AiWorker } from "@/lib/executive";
import {
  AUTONOMY_TONE,
  RUNTIME_TONE,
  deriveWorkerRuntime,
  sortWorkforce,
} from "@/lib/executive/worker-state";
import { EXECUTIVE_CENTER_DICT } from "@/lib/i18n/app/executive-center.i18n";
import { useCopy } from "@/lib/i18n/dict";
import { fetchEngineTasks, type EngineTask } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export const WORKER_ICON: Record<string, typeof Bot> = {
  whatsapp: MessageSquare,
  marketing: Sparkles,
  content: BrainCircuit,
  lead_intel: Radar,
  sales_elite: Target,
};

export function relativeTime(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** One label/value row inside a worker card — same structure for every worker. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-xs text-foreground/90">{value}</dd>
    </div>
  );
}

/**
 * One specialist operator card. Every worker uses the exact same card
 * architecture and the same turquoise/navy register — differentiation comes
 * from role and real state, never from colour.
 */
export function WorkerCard({
  worker,
  tasks,
  detailed = false,
}: {
  worker: AiWorker;
  tasks: EngineTask[];
  detailed?: boolean;
}) {
  const copy = useCopy(EXECUTIVE_CENTER_DICT);
  const Icon = WORKER_ICON[worker.worker_key] ?? Bot;
  const runtime = deriveWorkerRuntime(worker, tasks);

  return (
    <article className="panel card-interactive flex min-w-0 flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-xl border border-primary/30 bg-primary/10 p-2.5 text-primary">
            <Icon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{worker.name}</h3>
            <p className="line-clamp-2 text-xs text-muted-foreground">{worker.description}</p>
          </div>
        </div>
        <Badge className={cn("shrink-0 border-0", RUNTIME_TONE[runtime.state])}>
          {copy.runtime[runtime.state]}
        </Badge>
      </div>

      <dl className="grid gap-3 rounded-xl border border-border/60 bg-surface/60 px-3.5 py-3 sm:grid-cols-2">
        <Field label={copy.autonomyLabel} value={copy.autonomyValue[runtime.autonomy]} />
        <Field label={copy.stateLabel} value={copy.runtime[runtime.state]} />
        <Field
          label={copy.activeTaskLabel}
          value={runtime.activeTask ? runtime.activeTask.title : copy.noActiveTask}
        />
        <Field
          label={copy.lastExecutionLabel}
          value={
            runtime.lastExecutionAt ? relativeTime(runtime.lastExecutionAt) : copy.neverExecuted
          }
        />
        {detailed ? (
          <Field
            label={copy.executionLabel}
            value={`${runtime.counts.completed} completed · ${runtime.counts.awaitingApproval} awaiting · ${runtime.counts.failed} failed`}
          />
        ) : null}
      </dl>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span
          className={cn(
            "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
            AUTONOMY_TONE[runtime.autonomy],
          )}
        >
          {copy.autonomyValue[runtime.autonomy]}
        </span>
        <Button asChild size="sm" variant="outline">
          <WorkerLink workerKey={worker.worker_key}>
            {copy.openWorker}
            <ArrowRight className="size-4" aria-hidden="true" />
          </WorkerLink>
        </Button>
      </div>
    </article>
  );
}

/** The full Specialist AI Workforce grid, in a stable executive order. */
export function WorkforceGrid({ detailed = false }: { detailed?: boolean }) {
  const workers = useQuery({ queryKey: ["ai-workers"], queryFn: fetchWorkers });
  const engine = useQuery({ queryKey: ["engine-tasks"], queryFn: () => fetchEngineTasks(120) });

  if (workers.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-52 rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {sortWorkforce(workers.data ?? []).map((worker) => (
        <WorkerCard
          key={worker.id}
          worker={worker}
          tasks={engine.data ?? []}
          detailed={detailed}
        />
      ))}
    </div>
  );
}
