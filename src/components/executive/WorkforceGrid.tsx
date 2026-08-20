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

/**
 * Differentiated accent identity per specialist executive. Accents are limited to
 * icon, border, state and button so cards stay one coherent dark-navy system.
 */
type Accent = { icon: string; chipBorder: string; chipBg: string; state: string; button: string };
export const ACCENTS: Record<string, Accent> = {
  whatsapp: {
    icon: "text-primary border-primary/40 bg-primary/10",
    chipBorder: "border-primary/30",
    chipBg: "bg-primary/[0.07]",
    state: "text-primary",
    button: "border-primary/45 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
  },
  marketing: {
    icon: "text-emerald border-emerald/40 bg-emerald/10",
    chipBorder: "border-emerald/30",
    chipBg: "bg-emerald/[0.07]",
    state: "text-emerald",
    button: "border-emerald/45 bg-emerald/10 text-emerald hover:bg-emerald/20 hover:text-emerald",
  },
  content: {
    icon: "text-violet border-violet/40 bg-violet/10",
    chipBorder: "border-violet/30",
    chipBg: "bg-violet/[0.07]",
    state: "text-violet",
    button: "border-violet/45 bg-violet/10 text-violet hover:bg-violet/20 hover:text-violet",
  },
  lead_intel: {
    icon: "text-electric border-electric/40 bg-electric/10",
    chipBorder: "border-electric/30",
    chipBg: "bg-electric/[0.07]",
    state: "text-electric",
    button:
      "border-electric/45 bg-electric/10 text-electric hover:bg-electric/20 hover:text-electric",
  },
  sales_elite: {
    icon: "text-gold border-gold/50 bg-gold/12",
    chipBorder: "border-gold/35",
    chipBg: "bg-gold/[0.08]",
    state: "text-gold-bright",
    button: "border-gold/60 bg-gold/15 text-gold-bright hover:bg-gold/25 hover:text-gold-bright",
  },
};
export const DEFAULT_ACCENT: Accent = ACCENTS["whatsapp"]!;

export function relativeTime(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** One specialist operator card — role, real state, autonomy, task, last execution. */
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
  const accent = ACCENTS[worker.worker_key] ?? DEFAULT_ACCENT;
  const isElite = worker.worker_key === "sales_elite";
  const runtime = deriveWorkerRuntime(worker, tasks);

  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-4 p-5",
        isElite ? "panel-elite card-interactive-gold" : "panel card-interactive",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn("rounded-xl border p-2.5", accent.icon)}>
            <Icon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className={cn("truncate text-base font-semibold", isElite && "text-gold-bright")}>
              {worker.name}
            </h3>
            <p className="text-xs text-muted-foreground">{worker.description}</p>
          </div>
        </div>
        <Badge className={cn("shrink-0 border-0", RUNTIME_TONE[runtime.state])}>
          {copy.runtime[runtime.state]}
        </Badge>
      </div>

      <div className={cn("rounded-xl border px-3 py-2.5", accent.chipBorder, accent.chipBg)}>
        <p
          className={cn(
            "text-[10px] font-semibold uppercase tracking-[0.16em]",
            accent.state,
          )}
        >
          {copy.activeTaskLabel}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {runtime.activeTask ? runtime.activeTask.title : copy.noActiveTask}
        </p>
      </div>

      {detailed ? (
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {copy.lastExecutionLabel}
            </dt>
            <dd className="mt-0.5 truncate text-xs">
              {runtime.lastExecutionAt
                ? `${relativeTime(runtime.lastExecutionAt)}${
                    runtime.lastExecution ? ` · ${runtime.lastExecution.title}` : ""
                  }`
                : copy.neverExecuted}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {copy.executionLabel}
            </dt>
            <dd className="mt-0.5 text-xs tabular-nums text-muted-foreground">
              {runtime.counts.completed} ✓ · {runtime.counts.awaitingApproval} ⏳ ·{" "}
              {runtime.counts.failed} ✕
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span
          className={cn(
            "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
            AUTONOMY_TONE[runtime.autonomy],
          )}
        >
          {copy.autonomyValue[runtime.autonomy]}
        </span>
        <div className="flex min-w-0 items-center gap-3">
          {!detailed ? (
            <span className="truncate text-xs text-muted-foreground">
              {runtime.lastExecutionAt
                ? relativeTime(runtime.lastExecutionAt)
                : copy.neverExecuted}
            </span>
          ) : null}
          <Button asChild size="sm" variant="outline" className={accent.button}>
            <WorkerLink workerKey={worker.worker_key}>
              {copy.openWorker}
              <ArrowRight className="size-4" aria-hidden="true" />
            </WorkerLink>
          </Button>
        </div>
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
