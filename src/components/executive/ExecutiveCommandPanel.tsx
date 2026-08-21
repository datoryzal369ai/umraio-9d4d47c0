import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  Check,
  ClipboardCheck,
  Compass,
  Flame,
  Gauge,
  Layers,
  ListChecks,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchLeads } from "@/lib/leads";
import { fetchEngineTasks, computeTaskMetrics, ACTIVE_STATUSES } from "@/lib/tasks";
import { decideExecutiveTask } from "@/lib/executive-ai.functions";
import { type AiWorker } from "@/lib/executive";
import { cn } from "@/lib/utils";
import { useCopy } from "@/lib/i18n/dict";
import { EXECUTIVE_DICT } from "@/lib/i18n/app/executive.i18n";

type ControlKey =
  | "understand"
  | "prioritise"
  | "coordinate"
  | "recommend"
  | "monitor"
  | "escalate";

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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-surface/60 px-3 py-2">
      <p className="truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border/70 p-5 text-center text-sm text-muted-foreground">
      {children}
    </p>
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
  const queryClient = useQueryClient();
  const decide = useServerFn(decideExecutiveTask);
  const [openControl, setOpenControl] = useState<ControlKey | null>(null);

  const WORKER_ROLES: Record<string, string[]> = {
    whatsapp: copy.workerRoles.whatsapp,
    marketing: copy.workerRoles.marketing,
    content: copy.workerRoles.content,
    lead_intel: copy.workerRoles.leadIntel,
  };

  const CONTROLS: { key: ControlKey; label: string; icon: typeof Compass }[] = [
    { key: "understand", label: copy.roles.understand, icon: Compass },
    { key: "prioritise", label: copy.roles.prioritise, icon: ListChecks },
    { key: "coordinate", label: copy.roles.coordinate, icon: Users },
    { key: "recommend", label: copy.roles.recommend, icon: Sparkles },
    { key: "monitor", label: copy.roles.monitor, icon: Gauge },
    { key: "escalate", label: copy.roles.escalate, icon: AlertTriangle },
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

  const prioritised = [...highIntent].sort((a, b) => b.score - a.score).slice(0, 6);
  const topLead = [...staleHighIntent].sort((a, b) => b.score - a.score)[0];
  const approvals = tasks.filter((t) => t.status === "waiting_approval");
  const failed = tasks.filter((t) => t.status === "failed").slice(0, 5);
  const monitorTasks = tasks.slice(0, 8);

  const decideMutation = useMutation({
    mutationFn: (vars: { taskId: string; decision: "approve" | "reject" }) =>
      decide({ data: vars }),
    onSuccess: (_r, vars) => {
      toast.success(vars.decision === "approve" ? copy.toastApproved : copy.toastRejected);
      void queryClient.invalidateQueries({ queryKey: ["engine-tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["ai-tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["ai-workers"] });
      void queryClient.invalidateQueries({ queryKey: ["ai-metrics"] });
      void queryClient.invalidateQueries({ queryKey: ["ai-activity"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const recommendations: { text: string; to: string }[] = [];
  if (metrics.waitingApproval > 0)
    recommendations.push({ text: copy.pendingApprovalsExist(metrics.waitingApproval), to: "/tasks" });
  if (staleHighIntent.length > 0 && topLead)
    recommendations.push({
      text: copy.recommendedFollowUp(topLead.full_name, topLead.score),
      to: "/leads",
    });
  if (metrics.failed > 0) recommendations.push({ text: copy.tasksFailed(metrics.failed), to: "/tasks" });
  if (activeWorkers.length < workers.length && workers.length > 0)
    recommendations.push({ text: copy.paused, to: "/executive" });

  return (
    <section aria-labelledby="abe-heading" className="space-y-4">
      {/* Product hierarchy — every item navigates somewhere real. */}
      <nav aria-label={copy.whereThisSits} className="panel p-4">
        <div className="flex items-center gap-2">
          <Layers aria-hidden="true" className="size-4 text-primary" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {copy.whereThisSits}
          </h2>
        </div>
        <ol className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <HierarchyItem
            name="RÉNAIO.CORE™"
            role={copy.hierarchy.core}
            render={(inner) => (
              <Link to="/" hash="intelligence-architecture" className="min-w-0">
                {inner}
              </Link>
            )}
          />
          <HierarchyItem
            name="UMRAIO®"
            role={copy.hierarchy.umraio}
            render={(inner) => (
              <Link to="/" className="min-w-0">
                {inner}
              </Link>
            )}
          />
          <HierarchyItem
            name="AI Executive Center"
            role={copy.hierarchy.executiveCenter}
            render={(inner) => (
              <Link to="/executive" className="min-w-0">
                {inner}
              </Link>
            )}
          />
          <HierarchyItem
            name="AI AUTONOMOUS BUSINESS EXECUTIVE™"
            role={copy.hierarchy.orchestrator}
            render={(inner) => (
              <a href="#master-executive" className="min-w-0">
                {inner}
              </a>
            )}
          />
          <HierarchyItem
            name="Specialist AI Workforce"
            role={copy.hierarchy.workforce}
            last
            render={(inner) => (
              <a href="#ai-workforce" className="min-w-0">
                {inner}
              </a>
            )}
          />
        </ol>
      </nav>

      {/* MASTER EXECUTIVE — dominant orchestrator surface */}
      <div
        id="master-executive"
        className="panel-master relative scroll-mt-24 overflow-hidden p-5 sm:p-7"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-20 size-64 rounded-full bg-gold/10 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 top-10 size-64 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:gap-4">
            <div className="rounded-2xl border border-primary/45 bg-primary/10 p-3 shadow-[0_0_34px_-14px_var(--color-primary)]">
              <BrainCircuit aria-hidden="true" className="size-6 text-primary sm:size-7" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-primary">
                {copy.masterBadge}
              </p>
              <h2
                id="abe-heading"
                className="text-exec-intelligence max-w-[15ch] text-balance font-display text-[22px] font-extrabold uppercase leading-[1.08] tracking-[-0.01em] sm:text-3xl"
              >
                {copy.title}
              </h2>
              <p className="mt-2 text-xs font-medium text-foreground/75 sm:text-sm">{copy.subtitle}</p>
            </div>
          </div>
          <Badge
            className={cn(
              "shrink-0 border-0",
              "rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
              activeWorkers.length > 0
                ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                : "bg-muted text-muted-foreground",
            )}
          >
            {workersLoading ? copy.syncing : activeWorkers.length > 0 ? copy.active : copy.idle}
          </Badge>
        </div>

        {/* Executive controls — each opens a real panel below */}
        <div className="relative mt-5">
          <p className="text-[11px] text-muted-foreground">{copy.controlsHint}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {CONTROLS.map(({ key, label, icon: Icon }) => {
              const active = openControl === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-expanded={active}
                  aria-controls="executive-control-panel"
                  onClick={() => setOpenControl(active ? null : key)}
                  className={cn(
                    "inline-flex min-h-11 flex-1 basis-[calc(50%-0.25rem)] items-center justify-center gap-2 rounded-xl border px-3.5 py-2 text-[12px] font-semibold tracking-tight transition-colors sm:flex-none sm:basis-auto",
                    active
                      ? "border-primary/70 bg-primary/15 text-primary shadow-[0_0_30px_-16px_var(--color-primary)]"
                      : "border-primary/20 bg-surface/70 text-foreground/80 hover:border-primary/50 hover:text-primary",
                  )}
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {openControl ? (
          <div
            id="executive-control-panel"
            className="relative mt-4 rounded-xl border border-border/60 bg-surface/70 p-4"
          >
            {openControl === "understand" ? (
              <>
                <PanelTitle>{copy.panelUnderstandTitle}</PanelTitle>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label={copy.ctxOpenLeads} value={String(openLeads.length)} />
                  <Stat label={copy.ctxHighIntent} value={String(highIntent.length)} />
                  <Stat label={copy.ctxStale} value={String(staleHighIntent.length)} />
                  <Stat
                    label={copy.ctxActiveWorkers}
                    value={`${activeWorkers.length}/${workers.length}`}
                  />
                  <Stat label={copy.ctxRunningTasks} value={String(metrics.running)} />
                  <Stat label={copy.ctxQueuedTasks} value={String(metrics.queued)} />
                  <Stat label={copy.ctxCompletedTasks} value={String(metrics.completed)} />
                  <Stat label={copy.ctxPendingApprovals} value={String(metrics.waitingApproval)} />
                </div>
              </>
            ) : null}

            {openControl === "prioritise" ? (
              <>
                <PanelTitle>{copy.panelPrioritiseTitle}</PanelTitle>
                {prioritised.length === 0 ? (
                  <div className="mt-3">
                    <Empty>{copy.emptyPriority}</Empty>
                  </div>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {prioritised.map((lead) => (
                      <li
                        key={lead.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-surface px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{lead.full_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {copy.scoreLabel(lead.score)} · {lead.temperature} · {lead.stage}
                          </p>
                        </div>
                        <Button asChild size="sm" variant="outline">
                          <Link to="/leads/$leadId" params={{ leadId: lead.id }}>
                            {copy.openLead}
                          </Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}

            {openControl === "coordinate" ? (
              <>
                <PanelTitle>{copy.panelCoordinateTitle}</PanelTitle>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {workers.map((worker) => {
                    const wTasks = tasks.filter((t) => t.worker_key === worker.worker_key);
                    const running = wTasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;
                    const queued = wTasks.filter((t) => t.status === "queued").length;
                    const awaiting = wTasks.filter((t) => t.status === "waiting_approval").length;
                    const state = !worker.is_enabled
                      ? copy.paused
                      : running > 0
                        ? copy.workforceWorking(running, queued, awaiting)
                        : awaiting > 0
                          ? copy.pendingApprovalsExist(awaiting)
                          : copy.idle;
                    return (
                      <li
                        key={worker.id}
                        className="min-w-0 rounded-lg border border-border/60 bg-surface px-3 py-2"
                      >
                        <p className="truncate text-sm font-medium">{worker.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{state}</p>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            {openControl === "recommend" ? (
              <>
                <PanelTitle>{copy.panelRecommendTitle}</PanelTitle>
                {recommendations.length === 0 ? (
                  <div className="mt-3">
                    <Empty>{copy.emptyRecommendations}</Empty>
                  </div>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {recommendations.map((rec) => (
                      <li
                        key={rec.text}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-surface px-3 py-2"
                      >
                        <span className="min-w-0 text-sm">{rec.text}</span>
                        <Button asChild size="sm" variant="outline">
                          <Link to={rec.to}>{copy.recommendedNextAction.replace(":", "")}</Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}

            {openControl === "monitor" ? (
              <>
                <PanelTitle>{copy.panelMonitorTitle}</PanelTitle>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label={copy.ctxRunningTasks} value={String(metrics.running)} />
                  <Stat label={copy.ctxQueuedTasks} value={String(metrics.queued)} />
                  <Stat label={copy.ctxPendingApprovals} value={String(metrics.waitingApproval)} />
                  <Stat label={copy.ctxCompletedTasks} value={String(metrics.completed)} />
                </div>
                {monitorTasks.length === 0 ? (
                  <div className="mt-3">
                    <Empty>{copy.emptyMonitor}</Empty>
                  </div>
                ) : (
                  <ul className="mt-3 space-y-1.5">
                    {monitorTasks.map((task) => (
                      <li
                        key={task.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface px-3 py-2"
                      >
                        <p className="truncate text-sm">{task.title}</p>
                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {task.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}

            {openControl === "escalate" ? (
              <>
                <PanelTitle>{copy.panelEscalateTitle}</PanelTitle>
                {approvals.length === 0 && failed.length === 0 ? (
                  <div className="mt-3">
                    <Empty>{copy.emptyEscalations}</Empty>
                  </div>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {approvals.map((task) => (
                      <li
                        key={task.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-chart-4/30 bg-chart-4/[0.06] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{task.title}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {task.approval_reason ?? task.summary ?? task.worker_key}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={decideMutation.isPending}
                            onClick={() =>
                              decideMutation.mutate({ taskId: task.id, decision: "approve" })
                            }
                          >
                            <Check className="size-4" />
                            {copy.approve}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={decideMutation.isPending}
                            onClick={() =>
                              decideMutation.mutate({ taskId: task.id, decision: "reject" })
                            }
                          >
                            <X className="size-4" />
                            {copy.reject}
                          </Button>
                        </div>
                      </li>
                    ))}
                    {failed.map((task) => (
                      <li
                        key={task.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2"
                      >
                        <p className="truncate text-sm">{task.title}</p>
                        <Button asChild size="sm" variant="outline">
                          <Link to="/tasks">{copy.viewPendingApprovals}</Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </div>
        ) : null}

        <div className="relative mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
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
        <div className="relative mt-5 rounded-xl border border-border/60 bg-surface/60 p-4">
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

        <p className="relative mt-4 flex items-start gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {copy.advisoryNotice}
        </p>
      </div>

      {/* Worker coordination overview */}
      <div className="panel p-4">
        <div className="flex items-center gap-2">
          <Users aria-hidden="true" className="size-4 text-primary" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {copy.orchestrationHeading}
          </h2>
        </div>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
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

function PanelTitle({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-bright">
      {children}
    </h3>
  );
}

function HierarchyItem({
  name,
  role,
  last,
  render,
}: {
  name: string;
  role: string;
  last?: boolean;
  render: (inner: React.ReactNode) => React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2">
      {render(
        <span className="card-interactive block min-w-0 rounded-lg border border-border/60 bg-surface px-3 py-2">
          <span className="block truncate text-[12px] font-semibold">{name}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{role}</span>
        </span>,
      )}
      {!last ? (
        <ArrowRight
          aria-hidden="true"
          className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
        />
      ) : null}
    </li>
  );
}
