import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  ClipboardCheck,
  Flame,
  Layers,
  ListChecks,
  ShieldCheck,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchLeads } from "@/lib/leads";
import { fetchEngineTasks, computeTaskMetrics } from "@/lib/tasks";
import { type AiWorker } from "@/lib/executive";
import { cn } from "@/lib/utils";
import { useCopy } from "@/lib/i18n/dict";
import { EXECUTIVE_DICT } from "@/lib/i18n/app/executive.i18n";

function Metric({
  label,
  value,
  loading,
}: {
  label: string;
  value: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface/70 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-12" />
      ) : (
        <p className="mt-1 font-display text-xl font-bold tracking-tight">{value}</p>
      )}
    </div>
  );
}

export function ExecutiveCommandPanel({
  workers,
  workersLoading,
}: {
  workers: AiWorker[];
  workersLoading: boolean;
}) {
  const copy = useCopy(EXECUTIVE_DICT).commandPanel;

  const HIERARCHY = [
    { name: "RÉNAIO.CORE™", role: copy.hierarchy.core },
    { name: "UMRAIO®", role: copy.hierarchy.umraio },
    { name: "AI Executive Center", role: copy.hierarchy.executiveCenter },
    { name: "AI Autonomous Business Executive™", role: copy.hierarchy.orchestrator },
    { name: "Specialist AI Workforce", role: copy.hierarchy.workforce },
  ];

  const WORKER_ROLES: Record<string, string[]> = {
    whatsapp: copy.workerRoles.whatsapp,
    marketing: copy.workerRoles.marketing,
    content: copy.workerRoles.content,
    lead_intel: copy.workerRoles.leadIntel,
  };

  const ORCHESTRATOR_ROLES = [
    copy.roles.understand,
    copy.roles.prioritise,
    copy.roles.coordinate,
    copy.roles.recommend,
    copy.roles.monitor,
    copy.roles.escalate,
  ];

  const leadsQuery = useQuery({ queryKey: ["leads"], queryFn: fetchLeads });
  const tasksQuery = useQuery({ queryKey: ["engine-tasks"], queryFn: () => fetchEngineTasks(120) });

  const leads = leadsQuery.data ?? [];
  const openLeads = leads.filter((l) => !["completed", "lost"].includes(l.stage));
  const highIntent = openLeads.filter((l) => l.temperature === "hot" || l.score >= 70);
  const staleHighIntent = highIntent.filter(
    (l) =>
      !l.last_contact_at ||
      Date.now() - new Date(l.last_contact_at).getTime() > 24 * 60 * 60 * 1000,
  );

  const tasks = tasksQuery.data ?? [];
  const metrics = computeTaskMetrics(tasks);
  const activeWorkers = workers.filter((w) => w.is_enabled);
  const anyLoading = leadsQuery.isLoading || tasksQuery.isLoading || workersLoading;
  const hasError = leadsQuery.isError || tasksQuery.isError;

  const topLead = [...staleHighIntent].sort((a, b) => b.score - a.score)[0];

  return (
    <section aria-labelledby="abe-heading" className="space-y-4">
      {/* Product hierarchy */}
      <div className="panel p-4">
        <div className="flex items-center gap-2">
          <Layers aria-hidden="true" className="size-4 text-primary" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {copy.whereThisSits}
          </h2>
        </div>
        <ol className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          {HIERARCHY.map((level, index) => (
            <li key={level.name} className="flex min-w-0 items-center gap-2">
              <div className="card-interactive min-w-0 rounded-lg border border-border/60 bg-surface px-3 py-1.5">
                <p className="truncate text-[12px] font-semibold">{level.name}</p>
                <p className="truncate text-[10px] text-muted-foreground">{level.role}</p>
              </div>
              {index < HIERARCHY.length - 1 ? (
                <ArrowRight
                  aria-hidden="true"
                  className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      {/* Executive command panel */}
      <div className="panel-exec relative overflow-hidden p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 size-52 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-xl border border-platinum/25 bg-platinum/10 p-2.5">
              <BrainCircuit aria-hidden="true" className="size-5 text-platinum" />
            </div>
            <div className="min-w-0">
              <h2 id="abe-heading" className="text-chrome font-display text-lg font-bold tracking-tight">
                {copy.title}
              </h2>
              <p className="text-xs text-muted-foreground">
                {copy.subtitle}
              </p>
            </div>
          </div>
          <Badge
            className={cn(
              "shrink-0 border-0",
              activeWorkers.length > 0
                ? "bg-success/15 text-success"
                : "bg-muted text-muted-foreground",
            )}
          >
            {workersLoading ? copy.syncing : activeWorkers.length > 0 ? copy.active : copy.idle}
          </Badge>
        </div>

        <ul className="mt-4 flex flex-wrap gap-1.5">
          {ORCHESTRATOR_ROLES.map((role) => (
            <li
              key={role}
              className="rounded-full border border-border/60 bg-surface px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
            >
              {role}
            </li>
          ))}
        </ul>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <Metric
            label={copy.metricActiveWorkers}
            loading={workersLoading}
            value={`${activeWorkers.length}/${workers.length}`}
          />
          <Metric label={copy.metricTasksCoordinated} loading={anyLoading} value={String(tasks.length)} />
          <Metric
            label={copy.metricLeadsPrioritised}
            loading={anyLoading}
            value={String(highIntent.length)}
          />
          <Metric
            label={copy.metricAwaitingApproval}
            loading={anyLoading}
            value={String(metrics.waitingApproval)}
          />
          <Metric
            label={copy.metricOpportunitiesDetected}
            loading={anyLoading}
            value={String(staleHighIntent.length)}
          />
        </div>

        {/* Today's executive brief */}
        <div className="mt-5 rounded-xl border border-border/60 bg-surface/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {copy.briefTitle}
          </h3>

          {hasError ? (
            <p className="mt-3 text-sm text-destructive">
              {copy.briefError}
            </p>
          ) : anyLoading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <ListChecks aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  {metrics.running > 0 || metrics.queued > 0
                    ? copy.workforceWorking(metrics.running, metrics.queued, metrics.completed)
                    : copy.workforceIdle}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Flame aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-chart-4" />
                <span>
                  {highIntent.length > 0
                    ? staleHighIntent.length > 0
                      ? copy.highIntentWithStale(highIntent.length, staleHighIntent.length)
                      : copy.highIntentAllContacted(highIntent.length)
                    : copy.noOpportunities}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <ClipboardCheck
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span>
                  {metrics.waitingApproval > 0
                    ? copy.pendingApprovalsExist(metrics.waitingApproval)
                    : copy.noPendingApprovals}
                </span>
              </li>
              {metrics.failed > 0 ? (
                <li className="flex items-start gap-2">
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                  />
                  <span>{copy.tasksFailed(metrics.failed)}</span>
                </li>
              ) : null}
              <li className="flex items-start gap-2">
                <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  <span className="font-medium">{copy.recommendedNextAction}</span>
                  {metrics.waitingApproval > 0
                    ? copy.recommendedReviewApprovals
                    : topLead
                      ? copy.recommendedFollowUp(topLead.full_name, topLead.score)
                      : copy.recommendedNothingUrgent}
                </span>
              </li>
            </ul>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/tasks">{copy.viewPendingApprovals}</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/leads">{copy.viewHighIntentLeads}</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/analytics">{copy.viewExecutiveAnalytics}</Link>
            </Button>
          </div>
        </div>

        <p className="mt-4 flex items-start gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {copy.advisoryNotice}
        </p>
      </div>

      {/* Orchestration visual */}
      <div className="panel p-4">
        <div className="flex items-center gap-2">
          <Users aria-hidden="true" className="size-4 text-primary" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {copy.orchestrationHeading}
          </h2>
        </div>
        <div className="text-chrome mt-3 rounded-lg border border-platinum/25 bg-platinum/[0.06] px-3 py-2 text-[12px] font-semibold">
          AI AUTONOMOUS BUSINESS EXECUTIVE™
        </div>
        <div aria-hidden="true" className="mx-4 h-4 w-px bg-border" />
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {workersLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <li key={i}>
                  <Skeleton className="h-16 rounded-lg" />
                </li>
              ))
            : workers.map((worker) => (
                <li
                  key={worker.id}
                  className="card-interactive rounded-lg border border-border/60 bg-surface px-3 py-2"
                >
                  <p className="truncate text-[12px] font-semibold">{worker.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {(WORKER_ROLES[worker.worker_key] ?? []).join(" • ") || copy.specialistWorker}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {worker.is_enabled
                      ? worker.autonomy === "auto"
                        ? copy.autonomous
                        : copy.approvalRequired
                      : copy.paused}
                  </p>
                </li>
              ))}
        </ul>
      </div>
    </section>
  );
}
