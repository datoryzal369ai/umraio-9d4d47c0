import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ShieldCheck, Siren, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ExecutiveLoopTracker } from "@/components/executive/ExecutiveLoopTracker";
import { decideExecutiveTask } from "@/lib/executive-ai.functions";
import { getOutcomeMonitor } from "@/lib/executive/monitor.functions";
import {
  NOW_APPROVAL_LABEL,
  NOW_PRIORITY_TONE,
  NOW_STATE_LABEL,
  NOW_STATE_TONE,
  selectExecutiveNow,
} from "@/lib/executive/now.core";
import { OUTCOME_LABEL, OUTCOME_TONE, type OutcomeFinding } from "@/lib/executive/outcome.core";
import { fetchLeads } from "@/lib/leads";
import { fetchEngineTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 break-words text-sm">{value}</p>
    </div>
  );
}

/**
 * EXECUTIVE NOW — the single most important thing the AUTONOMOUS AI BUSINESS
 * EXECUTIVE™ wants the Agency Owner to know or decide right now. Populated
 * only from real executive action state; APPROVE is shown only when the action
 * is genuinely awaiting approval.
 */
export function ExecutiveNowCard() {
  const queryClient = useQueryClient();
  const decide = useServerFn(decideExecutiveTask);
  const monitor = useServerFn(getOutcomeMonitor);

  const tasksQuery = useQuery({ queryKey: ["engine-tasks"], queryFn: () => fetchEngineTasks(120) });
  const leadsQuery = useQuery({ queryKey: ["leads"], queryFn: fetchLeads });
  const findingsQuery = useQuery<OutcomeFinding[]>({
    queryKey: ["executive-outcomes"],
    queryFn: () => monitor({ data: undefined }) as Promise<OutcomeFinding[]>,
    refetchInterval: 120_000,
  });

  const decideMutation = useMutation({
    mutationFn: (vars: { taskId: string; decision: "approve" | "reject" }) =>
      decide({ data: vars }),
    onSuccess: (_r, vars) => {
      // Never optimistic: the UI re-reads backend state before claiming success.
      toast.success(vars.decision === "approve" ? "Action approved" : "Action rejected");
      for (const key of [
        ["engine-tasks"],
        ["ai-tasks"],
        ["ai-workers"],
        ["ai-metrics"],
        ["ai-activity"],
        ["executive-outcomes"],
        ["executive-audit"],
      ])
        void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const loading = tasksQuery.isLoading || leadsQuery.isLoading;
  const now = loading
    ? null
    : selectExecutiveNow({
        tasks: tasksQuery.data ?? [],
        leads: leadsQuery.data ?? [],
        findings: findingsQuery.data ?? [],
      });

  return (
    <section
      id="executive-now"
      aria-labelledby="executive-now-heading"
      className="panel-master relative scroll-mt-24 overflow-hidden p-5 sm:p-6"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-gold/10 blur-3xl"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-xl border border-gold/40 bg-gold/10 p-2.5">
            <Siren aria-hidden="true" className="size-5 text-gold-bright" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.26em] text-primary">
              AI AUTONOMOUS BUSINESS EXECUTIVE™
            </p>
            <h2
              id="executive-now-heading"
              className="text-master font-display text-xl font-extrabold tracking-tight sm:text-2xl"
            >
              EXECUTIVE NOW
            </h2>
          </div>
        </div>
        {now ? (
          <div className="flex flex-wrap gap-2">
            <Badge className={cn("border-0", NOW_PRIORITY_TONE[now.priority])}>
              {now.priority}
            </Badge>
            <Badge className={cn("border-0", NOW_STATE_TONE[now.state])}>
              {NOW_STATE_LABEL[now.state]}
            </Badge>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="relative mt-4 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : !now ? (
        <div className="relative mt-4 rounded-xl border border-border/60 bg-surface/60 p-4">
          <p className="text-sm font-medium">No immediate executive action required.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {(tasksQuery.data ?? []).length === 0
              ? "No executive action has been recorded yet. Run an orchestration cycle to let the Executive assess the pipeline."
              : "Nothing is awaiting approval, executing or escalated. Monitoring continues in the background."}
          </p>
        </div>
      ) : (
        <div className="relative mt-4 space-y-4">
          <div className="grid gap-3 rounded-xl border border-border/60 bg-surface/60 p-4 sm:grid-cols-2">
            <Field label="Objective" value={now.objective} />
            <Field label="Target" value={now.target ?? "INSUFFICIENT DATA — no target recorded"} />
            <Field label="Worker" value={now.worker} />
            <Field
              label="Reason"
              value={now.reason ?? "INSUFFICIENT DATA — no decision reason recorded"}
            />
            <Field
              label="Confidence"
              value={
                now.confidence == null
                  ? "INSUFFICIENT DATA — the decision recorded no confidence"
                  : `${now.confidence}%${now.confidence < 60 ? " · LOW CONFIDENCE" : ""}`
              }
            />
            <Field
              label="Expected outcome (intended, not guaranteed)"
              value={now.expectedOutcome ?? "INSUFFICIENT DATA — no expected outcome recorded"}
            />
            <Field label="Approval" value={NOW_APPROVAL_LABEL[now.approval]} />
            <Field label="Current state" value={NOW_STATE_LABEL[now.state]} />
          </div>

          {now.state === "monitoring" ? (
            <p className="rounded-lg border border-electric/30 bg-electric/[0.06] px-3 py-2 text-xs text-muted-foreground">
              <span className="font-semibold text-electric">OUTCOME PENDING</span> — the action
              executed successfully. That is not a business outcome until the customer or pipeline
              actually moves.
            </p>
          ) : null}
          {now.finding ? (
            <p className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2 text-xs">
              <Badge className={cn("mr-2 border-0", OUTCOME_TONE[now.finding.outcome])}>
                {OUTCOME_LABEL[now.finding.outcome]}
              </Badge>
              <span className="text-muted-foreground">{now.finding.detail}</span>
            </p>
          ) : null}
          {now.state === "failed" || now.state === "escalated" ? (
            <p className="rounded-lg border border-destructive/35 bg-destructive/[0.07] px-3 py-2 text-xs text-destructive">
              {now.task.error ?? "The side effect failed. The action remains FAILED."}
            </p>
          ) : null}

          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Executive loop — this action
            </h3>
            <div className="mt-2">
              <ExecutiveLoopTracker task={now.task} finding={now.finding} />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              {now.targetLeadId ? (
                <Link to="/leads/$leadId" params={{ leadId: now.targetLeadId }}>
                  REVIEW
                </Link>
              ) : (
                <Link to="/tasks">REVIEW</Link>
              )}
            </Button>
            {now.canApprove ? (
              <>
                <Button
                  size="sm"
                  disabled={decideMutation.isPending}
                  onClick={() =>
                    decideMutation.mutate({ taskId: now.task.id, decision: "approve" })
                  }
                >
                  <Check className="size-4" aria-hidden="true" />
                  APPROVE
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decideMutation.isPending}
                  onClick={() => decideMutation.mutate({ taskId: now.task.id, decision: "reject" })}
                >
                  <X className="size-4" aria-hidden="true" />
                  REJECT
                </Button>
              </>
            ) : null}
            <Button asChild size="sm" variant="ghost">
              <Link to="/executive/audit">AUDIT TRAIL</Link>
            </Button>
          </div>
        </div>
      )}

      <p className="relative mt-4 flex items-start gap-2 text-[11px] text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
        Approval, execution and outcome states are read back from the backend. Nothing is shown as
        successful before the real side effect succeeds.
      </p>
    </section>
  );
}
