import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock,
  ListChecks,
  MessageSquare,
  ShieldCheck,
  Target,
  TicketCheck,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";

import { useCopy } from "@/lib/i18n/dict";
import { EXECUTIVE_DICT } from "@/lib/i18n/app/executive.i18n";
import { EXECUTIVE_CENTER_DICT } from "@/lib/i18n/app/executive-center.i18n";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { ExecutiveCommandPanel } from "@/components/executive/ExecutiveCommandPanel";
import { OrchestrationPanel } from "@/components/executive/OrchestrationPanel";
import { SalesOpportunities } from "@/components/executive/SalesOpportunities";
import { WorkforceGrid } from "@/components/executive/WorkforceGrid";

import { Button } from "@/components/ui/button";
import { fetchAiActivity, fetchExecutiveMetrics, fetchTasks, fetchWorkers } from "@/lib/executive";
import { fetchSalesOpportunities } from "@/lib/sales-opportunities";
import { myr } from "@/lib/dashboard";
import { fetchEngineTasks } from "@/lib/tasks";
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
        content: "Live control room for your AUTONOMOUS AI BUSINESS EXECUTIVE™ workforce.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ExecutiveCenter,
});

/** One telemetry cell in the executive status strip — always navigates somewhere real. */
function Telemetry({
  icon: Icon,
  label,
  value,
  hint,
  to,
  hash,
  tone,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
  hint: string;
  to?: "/tasks" | undefined;
  hash?: string | undefined;
  tone?: string | undefined;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <Icon className={cn("size-3.5", tone ?? "text-primary")} aria-hidden="true" />
        {label}
      </span>
      <span className={cn("mt-2 block truncate text-lg font-semibold", tone)}>{value}</span>
      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{hint}</span>
    </>
  );

  const className =
    "card-interactive block min-w-0 rounded-xl border border-border/60 bg-surface/70 p-3 text-left";

  if (to) {
    return (
      <Link to={to} className={className}>
        {body}
      </Link>
    );
  }
  if (hash) {
    return (
      <a href={hash} className={className}>
        {body}
      </a>
    );
  }
  return <div className={className}>{body}</div>;
}

function ExecutiveCenter() {
  const copy = useCopy(EXECUTIVE_DICT).overview;
  const center = useCopy(EXECUTIVE_CENTER_DICT);

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
  const engineTasksQuery = useQuery({
    queryKey: ["engine-tasks"],
    queryFn: () => fetchEngineTasks(120),
  });
  const opportunities = useQuery({
    queryKey: ["sales-opportunities"],
    queryFn: fetchSalesOpportunities,
  });

  const m = metrics.data;
  const engineTasks = engineTasksQuery.data ?? [];
  const allWorkers = workers.data ?? [];
  const online = allWorkers.filter((w) => w.is_enabled).length;
  const offline = allWorkers.length - online;
  const approvals = m?.pendingApprovals ?? 0;
  const opportunityCount = (opportunities.data ?? []).length;
  const ready = !metrics.isLoading && !workers.isLoading && !engineTasksQuery.isLoading;
  // Escalations are real: an approval-gated action that failed needs a human.
  const escalations = engineTasks.filter(
    (t) => t.status === "failed" && t.requires_approval,
  ).length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      {/* Executive hero — identity, purpose and live telemetry in one glance. */}
      <header className="panel-master overflow-hidden p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              {center.heroEyebrow}
            </p>
            <h1 className="mt-1.5 font-display text-2xl font-bold tracking-tight sm:text-4xl">
              <span className="text-master">{center.heroTitle}</span>
            </h1>
            <p className="mt-1.5 text-sm font-medium text-foreground/90">{center.heroSubtitle}</p>
            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              {center.heroLine}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/executive/workforce">
                <Users className="size-4" aria-hidden="true" />
                {center.viewWorkforce}
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/tasks">
                <ListChecks className="size-4" aria-hidden="true" />
                {center.openTaskControl}
              </Link>
            </Button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-5">
          <Telemetry
            icon={Activity}
            label={center.telemetry.systemStatus}
            value={
              !ready
                ? center.telemetry.systemSyncing
                : escalations > 0
                  ? center.telemetry.systemAttention
                  : center.telemetry.systemActive
            }
            hint={
              !ready
                ? copy.syncing
                : escalations > 0
                  ? center.telemetry.escalations(escalations)
                  : center.nowNoEscalations
            }
            tone={escalations > 0 ? "text-destructive" : "text-emerald"}
          />
          <Telemetry
            icon={Users}
            label={center.telemetry.workers}
            value={
              workers.isLoading
                ? "—"
                : center.telemetry.workersOnline(online, allWorkers.length)
            }
            hint={
              workers.isLoading
                ? copy.syncing
                : allWorkers.length === 0
                  ? center.telemetry.noWorkers
                  : offline > 0
                    ? center.telemetry.awaitingActivation(offline)
                    : center.nowHealthy
            }
            hash="#executive-workforce"
          />
          <Telemetry
            icon={ListChecks}
            label={center.telemetry.tasks}
            value={m ? center.telemetry.tasksToday(m.tasksToday) : "—"}
            hint={
              engineTasksQuery.isLoading
                ? copy.syncing
                : center.telemetry.tasksRecent(engineTasks.length)
            }
            to="/tasks"
          />
          <Telemetry
            icon={ShieldCheck}
            label={center.telemetry.approvals}
            value={
              approvals > 0
                ? center.telemetry.approvalsWaiting(approvals)
                : center.telemetry.approvalsClear
            }
            hint={approvals > 0 ? center.openApprovalQueue : center.nowHealthyBody}
            to="/tasks"
            tone={approvals > 0 ? "text-gold-bright" : undefined}
          />
          <Telemetry
            icon={Target}
            label={center.telemetry.opportunities}
            value={
              opportunityCount > 0
                ? center.telemetry.opportunitiesDetected(opportunityCount)
                : center.telemetry.opportunitiesNone
            }
            hint={center.openOpportunities}
            hash="#executive-opportunities"
          />
        </div>
      </header>

      {/* 1. EXECUTIVE NOW — what needs attention right now. */}
      <ExecutiveNowCard />

      {/* 2. EXECUTIVE INSIGHT — what the Executive understands, with evidence. */}
      <ExecutiveInsight />

      {/* 3. EXECUTIVE LOOP — the general control surface plus orchestration. */}
      <ExecutiveCommandPanel workers={allWorkers} workersLoading={workers.isLoading} />

      <OrchestrationPanel />

      {/* Business outcomes of what already executed. */}
      <OutcomeMonitor />

      <section id="executive-opportunities" className="scroll-mt-24">
        <SalesOpportunities />
      </section>

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

      <section id="executive-workforce" className="scroll-mt-24 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              {center.workforceTitle}
            </h2>
            <p className="text-xs text-muted-foreground">{center.workforceSubtitle}</p>
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link to="/executive/workforce">
              {center.viewWorkforce}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <WorkforceGrid />
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
            <CalendarClock className="size-4 text-primary" aria-hidden="true" />
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
