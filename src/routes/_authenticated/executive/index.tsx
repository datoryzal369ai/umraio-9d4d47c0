import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  Clock,
  MessageSquare,
  Radar,
  Sparkles,
  Target,
  TicketCheck,
  TrendingUp,
  UserPlus,
} from "lucide-react";

import { PageHeader } from "@/components/app/PageHeader";
import { useCopy } from "@/lib/i18n/dict";
import { EXECUTIVE_DICT } from "@/lib/i18n/app/executive.i18n";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { ExecutiveCommandPanel } from "@/components/executive/ExecutiveCommandPanel";
import { OrchestrationPanel } from "@/components/executive/OrchestrationPanel";
import { SalesOpportunities } from "@/components/executive/SalesOpportunities";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  STATUS_LABEL,
  STATUS_TONE,
  fetchAiActivity,
  fetchExecutiveMetrics,
  fetchTasks,
  fetchWorkers,
  type WorkerStatus,
} from "@/lib/executive";
import { myr } from "@/lib/dashboard";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/executive/")({
  head: () => ({
    meta: [
      { title: "AI Executive Center — UMRAIO" },
      {
        name: "description",
        content:
          "Command every UMRAIO AI worker from one place: live status, tasks completed, leads generated, revenue influenced and hours saved.",
      },
      { property: "og:title", content: "AI Executive Center — UMRAIO" },
      {
        property: "og:description",
        content: "Live control room for your AI Autonomous Business Executive workforce.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ExecutiveCenter,
});

const workerIcon: Record<string, typeof Bot> = {
  whatsapp: MessageSquare,
  marketing: Sparkles,
  content: BrainCircuit,
  lead_intel: Radar,
  sales_elite: Target,
};

/** Workers that own a dedicated workspace route instead of the generic worker page. */
const WORKER_ROUTES: Record<string, "/sales-elite"> = {
  sales_elite: "/sales-elite",
};


function ExecutiveCenter() {
  const copy = useCopy(EXECUTIVE_DICT).overview;

  const relative = (iso: string) => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return copy.minAgo(Math.max(mins, 1));
    if (mins < 1440) return copy.hAgo(Math.round(mins / 60));
    return copy.dAgo(Math.round(mins / 1440));
  };

  const workers = useQuery({ queryKey: ["ai-workers"], queryFn: fetchWorkers });
  const metrics = useQuery({
    queryKey: ["ai-metrics"],
    queryFn: fetchExecutiveMetrics,
    refetchInterval: 60_000,
  });
  const tasks = useQuery({ queryKey: ["ai-tasks", "all"], queryFn: () => fetchTasks(undefined, 8) });
  const activity = useQuery({ queryKey: ["ai-activity"], queryFn: () => fetchAiActivity(20) });

  const m = metrics.data;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        description={copy.description}
        actions={
          <div className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <Bot className="size-4 text-primary" />
            <span className="text-xs font-medium">
              {m ? copy.waitingApproval(m.pendingApprovals) : copy.syncing}
            </span>
          </div>
        }
      />

      <ExecutiveCommandPanel workers={workers.data ?? []} workersLoading={workers.isLoading} />

      <OrchestrationPanel />

      <SalesOpportunities />


      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          icon={CheckCircle2}
          label={copy.tasksCompletedLabel}
          value={m ? String(m.tasksToday) : "—"}
          hint={copy.tasksCompletedHint}
        />
        <KpiCard
          icon={MessageSquare}
          label={copy.messagesAnsweredLabel}
          value={m ? String(m.messagesAnswered) : "—"}
          hint={copy.messagesAnsweredHint}
        />
        <KpiCard
          icon={UserPlus}
          label={copy.leadsGeneratedLabel}
          value={m ? String(m.leadsGenerated) : "—"}
          hint={copy.leadsGeneratedHint}
        />
        <KpiCard
          icon={TicketCheck}
          label={copy.bookingsAssistedLabel}
          value={m ? String(m.bookingsAssisted) : "—"}
          hint={copy.bookingsAssistedHint}
        />
        <KpiCard
          icon={TrendingUp}
          label={copy.revenueInfluencedLabel}
          value={m ? myr(m.revenueInfluenced) : "—"}
          hint={copy.revenueInfluencedHint}
        />
        <KpiCard
          icon={Clock}
          label={copy.hoursSavedLabel}
          value={m ? `${m.hoursSaved.toFixed(1)}h` : "—"}
          hint={copy.hoursSavedHint}
        />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {workers.isLoading
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)
          : (workers.data ?? []).map((worker) => {
              const Icon = workerIcon[worker.worker_key] ?? Bot;
              const status = (worker.is_enabled ? worker.status : "idle") as WorkerStatus;
              const isElite = worker.worker_key === "sales_elite";
              const workerTasks = engineTasks.filter((t) => t.worker_key === worker.worker_key);
              const running = workerTasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;
              const queued = workerTasks.filter((t) => t.status === "queued").length;
              const awaiting = workerTasks.filter((t) => t.status === "waiting_approval").length;
              const nextTask =
                workerTasks.find((t) => t.status === "waiting_approval") ??
                workerTasks.find((t) => ACTIVE_STATUSES.includes(t.status)) ??
                workerTasks.find((t) => t.status === "queued") ??
                null;
              const liveState = !worker.is_enabled
                ? copy.stateIdle
                : running > 0
                  ? copy.stateRunning(running)
                  : awaiting > 0
                    ? copy.stateWaitingApproval(awaiting)
                    : queued > 0
                      ? copy.stateQueued(queued)
                      : tasksLoading
                        ? copy.syncing
                        : copy.stateReady;
              return (
                <article
                  key={worker.id}
                  className={cn(
                    "flex min-w-0 flex-col gap-4 p-5",
                    isElite ? "panel-elite card-interactive-gold" : "panel card-interactive",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className={cn(
                          "rounded-xl border p-2.5",
                          isElite ? "border-gold/40 bg-gold/10" : "border-border/60 bg-surface",
                        )}
                      >
                        <Icon className={cn("size-5", isElite ? "text-gold" : "text-primary")} />
                      </div>
                      <div className="min-w-0">
                        <h2 className={cn("truncate text-base font-semibold", isElite && "text-champagne")}>{worker.name}</h2>
                        <p className="text-xs text-muted-foreground">{worker.description}</p>
                      </div>
                    </div>
                    <Badge className={cn("shrink-0 border-0", STATUS_TONE[status])}>
                      {STATUS_LABEL[status]}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 text-xs text-muted-foreground">
                      {worker.last_run_at ? copy.lastRun(relative(worker.last_run_at)) : copy.notRunYet}
                      {" · "}
                      {worker.autonomy === "auto" ? copy.autonomous : copy.approvalRequired}
                    </p>
                    <Button asChild size="sm" variant="outline">
                      {WORKER_ROUTES[worker.worker_key] ? (
                        <Link to={WORKER_ROUTES[worker.worker_key]!}>{copy.openWorker}</Link>
                      ) : (
                        <Link
                          to="/executive/$workerKey"
                          params={{ workerKey: worker.worker_key }}
                        >
                          {copy.openWorker}
                        </Link>
                      )}
                    </Button>

                  </div>
                </article>
              );
            })}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel min-w-0 p-5">
          <h2 className="text-base font-semibold">{copy.latestTasksTitle}</h2>
          <p className="text-xs text-muted-foreground">{copy.latestTasksSubtitle}</p>
          <ul className="mt-4 space-y-2">
            {(tasks.data ?? []).length === 0 ? (
              <li className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                {copy.noTasksYet}
              </li>
            ) : (
              (tasks.data ?? []).map((task) => (
                <li
                  key={task.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-surface p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{task.title}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {task.summary ?? task.error ?? copy.processing}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relative(task.created_at)}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="panel min-w-0 p-5">
          <div className="flex items-center gap-3">
            <CalendarClock className="size-4 text-primary" />
            <div>
              <h2 className="text-base font-semibold">{copy.activityLogTitle}</h2>
              <p className="text-xs text-muted-foreground">{copy.activityLogSubtitle}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-1">
            {(activity.data ?? []).length === 0 ? (
              <li className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                {copy.nothingLoggedYet}
              </li>
            ) : (
              (activity.data ?? []).map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        "shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        item.actor === "ai"
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {item.actor}
                    </span>
                    <p className="truncate text-sm">{item.action}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relative(item.created_at)}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      </section>
    </div>
  );
}
