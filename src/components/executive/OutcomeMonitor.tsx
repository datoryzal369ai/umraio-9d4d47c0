import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, ArrowDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getOutcomeMonitor } from "@/lib/executive/monitor.functions";
import {
  OUTCOME_INTERPRETATION,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  type OutcomeFinding,
} from "@/lib/executive/outcome.core";
import { cn } from "@/lib/utils";

function hoursAgo(iso: string) {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? "under an hour ago" : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function TimelineStep({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <li className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("break-words text-[13px]", tone)}>{value}</p>
    </li>
  );
}

/**
 * OUTCOME MONITOR — surfaces the server-side `monitorExecutedDecisions`
 * findings. Action completion is displayed separately from business outcome,
 * and no outcome is claimed that the lead/business state does not support.
 */
export function OutcomeMonitor() {
  const monitor = useServerFn(getOutcomeMonitor);
  const query = useQuery<OutcomeFinding[]>({
    queryKey: ["executive-outcomes"],
    queryFn: () => monitor({ data: undefined }) as Promise<OutcomeFinding[]>,
    refetchInterval: 120_000,
  });

  const findings = query.data ?? [];

  return (
    <section
      id="executive-outcomes"
      aria-labelledby="outcome-heading"
      className="panel scroll-mt-24 p-5"
    >
      <div className="flex items-center gap-3">
        <Activity aria-hidden="true" className="size-4 text-electric" />
        <div className="min-w-0">
          <h2 id="outcome-heading" className="text-base font-semibold">
            Outcome Monitor
          </h2>
          <p className="text-xs text-muted-foreground">
            What actually happened after the Executive executed — action completion is not business
            success.
          </p>
        </div>
      </div>

      {query.isLoading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : query.isError ? (
        <p className="mt-4 text-sm text-destructive">
          Outcome monitoring could not be read. No outcome is shown rather than an assumed one.
        </p>
      ) : findings.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border/70 p-5 text-center text-sm text-muted-foreground">
          INSUFFICIENT DATA — no executed executive action has been observable long enough to be
          measured yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {findings.map((f) => (
            <li key={f.taskId} className="rounded-xl border border-border/60 bg-surface/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-semibold">{f.subject}</p>
                <Badge className={cn("border-0", OUTCOME_TONE[f.outcome])}>
                  {OUTCOME_LABEL[f.outcome]}
                </Badge>
              </div>

              <ol className="mt-3 space-y-2">
                <TimelineStep label="Action" value={`Completed ${hoursAgo(f.executedAt)}.`} />
                <li aria-hidden="true">
                  <ArrowDown className="size-3.5 text-muted-foreground" />
                </li>
                <TimelineStep
                  label="Business outcome"
                  value={OUTCOME_LABEL[f.outcome]}
                  tone="font-semibold"
                />
                <li aria-hidden="true">
                  <ArrowDown className="size-3.5 text-muted-foreground" />
                </li>
                <TimelineStep
                  label="Executive interpretation"
                  value={`${OUTCOME_INTERPRETATION[f.outcome]} ${f.detail}`}
                />
                <li aria-hidden="true">
                  <ArrowDown className="size-3.5 text-muted-foreground" />
                </li>
                <TimelineStep label="Executive decision" value={f.nextAction} />
              </ol>

              {f.outcome === "no_response" ? (
                <p className="mt-3 rounded-lg border border-ruby/35 bg-ruby/[0.07] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ruby-bright">
                  Escalated — human sales review required
                </p>
              ) : null}

              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to="/leads/$leadId" params={{ leadId: f.leadId }}>
                  REVIEW NEXT ACTION
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
