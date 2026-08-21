import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BrainCircuit } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EVIDENCE_LABEL,
  EVIDENCE_TONE,
  buildExecutiveInsights,
} from "@/lib/executive/evidence.core";
import { getOutcomeMonitor } from "@/lib/executive/monitor.functions";
import type { OutcomeFinding } from "@/lib/executive/outcome.core";
import { fetchLeads } from "@/lib/leads";
import { fetchEngineTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * EXECUTIVE INSIGHT — every conclusion is classified as FACT, SIGNAL,
 * INTERPRETATION or RECOMMENDATION, or explicitly marked INSUFFICIENT DATA.
 * Missing evidence is never replaced with generic neutral copy.
 */
export function ExecutiveInsight() {
  const monitor = useServerFn(getOutcomeMonitor);
  const leadsQuery = useQuery({ queryKey: ["leads"], queryFn: fetchLeads });
  const tasksQuery = useQuery({ queryKey: ["engine-tasks"], queryFn: () => fetchEngineTasks(120) });
  const findingsQuery = useQuery<OutcomeFinding[]>({
    queryKey: ["executive-outcomes"],
    queryFn: () => monitor({ data: undefined }) as Promise<OutcomeFinding[]>,
    refetchInterval: 120_000,
  });

  const loading = leadsQuery.isLoading || tasksQuery.isLoading;
  const insights = loading
    ? []
    : buildExecutiveInsights({
        leads: leadsQuery.data ?? [],
        tasks: tasksQuery.data ?? [],
        findings: findingsQuery.data ?? [],
      });

  return (
    <section id="executive-insight" aria-labelledby="insight-heading" className="panel scroll-mt-24 p-5">
      <div className="flex items-center gap-3">
        <BrainCircuit aria-hidden="true" className="size-4 text-primary" />
        <div className="min-w-0">
          <h2 id="insight-heading" className="text-base font-semibold">
            Executive Insight
          </h2>
          <p className="text-xs text-muted-foreground">
            What the Executive understands — with the evidence behind it.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : insights.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border/70 p-5 text-center text-sm text-muted-foreground">
          INSUFFICIENT DATA — there is no persisted lead or task activity to reason about yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {insights.map((insight) => (
            <li key={insight.id} className="rounded-xl border border-border/60 bg-surface/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{insight.title}</h3>
                {insight.confidence ? (
                  <Badge
                    className={cn(
                      "border-0 text-[10px] uppercase tracking-wider",
                      insight.confidence === "low"
                        ? "bg-gold/15 text-gold-bright"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {insight.confidence === "low"
                      ? "LOW CONFIDENCE"
                      : `${insight.confidence} confidence`}
                  </Badge>
                ) : null}
              </div>

              {insight.insufficient ? (
                <div className="mt-3 rounded-lg border border-gold/35 bg-gold/[0.06] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gold-bright">
                    INSUFFICIENT DATA
                  </p>
                  <p className="mt-1 text-sm">{insight.insufficient.reason}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Missing: {insight.insufficient.missing.join(", ")}.
                  </p>
                </div>
              ) : (
                <dl className="mt-3 space-y-2">
                  {insight.evidence.map((item) => (
                    <div key={item.kind} className="flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3">
                      <dt className="shrink-0">
                        <span
                          className={cn(
                            "inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em]",
                            EVIDENCE_TONE[item.kind],
                          )}
                        >
                          {EVIDENCE_LABEL[item.kind]}
                        </span>
                      </dt>
                      <dd className="min-w-0 break-words text-[13px] leading-snug">{item.text}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {insight.link ? (
                <Button asChild size="sm" variant="outline" className="mt-3">
                  <Link to={insight.link.to}>{insight.link.label}</Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
