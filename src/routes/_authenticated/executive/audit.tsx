import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";

import { PageHeader } from "@/components/app/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AUDIT_CATEGORY_LABEL,
  AUDIT_CATEGORY_TONE,
  fetchAuditRows,
  type AuditCategory,
} from "@/lib/executive/audit";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/executive/audit")({
  head: () => ({
    meta: [
      { title: "Executive Audit Log — UMRAIO" },
      {
        name: "description",
        content:
          "Read-only evidence trail of every UMRAIO executive decision, approval, execution, monitoring check and escalation.",
      },
      { property: "og:title", content: "Executive Audit Log — UMRAIO" },
      {
        property: "og:description",
        content: "Every executive decision, approval, execution and outcome — as recorded.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuditLogPage,
});

const FILTERS: { key: AuditCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "decision", label: AUDIT_CATEGORY_LABEL.decision },
  { key: "approval", label: AUDIT_CATEGORY_LABEL.approval },
  { key: "execution", label: AUDIT_CATEGORY_LABEL.execution },
  { key: "failure", label: AUDIT_CATEGORY_LABEL.failure },
  { key: "monitoring", label: AUDIT_CATEGORY_LABEL.monitoring },
  { key: "escalation", label: AUDIT_CATEGORY_LABEL.escalation },
];

function timeOf(iso: string) {
  const d = new Date(iso);
  return {
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    date: d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }),
  };
}

function AuditLogPage() {
  const [filter, setFilter] = useState<AuditCategory | "all">("all");
  const [worker, setWorker] = useState<string>("all");

  const auditQuery = useQuery({ queryKey: ["executive-audit"], queryFn: () => fetchAuditRows(200) });
  const rows = useMemo(() => auditQuery.data ?? [], [auditQuery.data]);

  const workers = useMemo(
    () => Array.from(new Set(rows.map((r) => r.workerKey).filter(Boolean) as string[])),
    [rows],
  );

  const visible = rows.filter(
    (r) =>
      (filter === "all" || r.category === filter) && (worker === "all" || r.workerKey === worker),
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <ScrollText aria-hidden="true" className="size-3.5" />
            AI Executive Center
          </span>
        }
        title="Executive Audit Log"
        description="Read-only evidence: decisions, approvals, executions, monitoring checks and escalations, exactly as recorded."
        backTo="/executive"
      />

      <div className="panel p-4">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "min-h-10 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                filter === f.key
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border/60 bg-surface text-muted-foreground hover:text-primary",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {workers.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={worker === "all"}
              onClick={() => setWorker("all")}
              className={cn(
                "min-h-9 rounded-full border px-3 py-1 text-[11px] font-medium",
                worker === "all"
                  ? "border-gold/50 bg-gold/10 text-gold-bright"
                  : "border-border/60 bg-surface text-muted-foreground",
              )}
            >
              All workers
            </button>
            {workers.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={worker === w}
                onClick={() => setWorker(w)}
                className={cn(
                  "min-h-9 rounded-full border px-3 py-1 text-[11px] font-medium",
                  worker === w
                    ? "border-gold/50 bg-gold/10 text-gold-bright"
                    : "border-border/60 bg-surface text-muted-foreground",
                )}
              >
                {w}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="panel p-4">
        {auditQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : auditQuery.isError ? (
          <p className="p-4 text-sm text-destructive">
            The audit trail could not be loaded. No events are shown rather than approximate ones.
          </p>
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
            No recorded events match this filter.
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((row) => {
              const t = timeOf(row.at);
              return (
                <li
                  key={row.id}
                  className="rounded-xl border border-border/60 bg-surface/60 p-3 sm:flex sm:items-start sm:gap-4"
                >
                  <div className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:w-20">
                    {t.time}
                    <span className="ml-1.5 sm:ml-0 sm:block sm:font-normal">{t.date}</span>
                  </div>
                  <div className="mt-1.5 min-w-0 flex-1 sm:mt-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={cn("border-0", AUDIT_CATEGORY_TONE[row.category])}>
                        {row.event}
                      </Badge>
                      {row.state ? (
                        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                          {row.state}
                        </span>
                      ) : null}
                      {row.result ? (
                        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                          {row.result}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 break-words text-sm">{row.action}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {row.actor}
                      {row.entity ? ` · ${row.entity}` : ""}
                      {row.leadId ? ` · Lead #${row.leadId.slice(0, 8).toUpperCase()}` : ""}
                      {row.approver ? ` · Approver: ${row.approver}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-[11px] text-muted-foreground">
          This log is evidence and is read-only. Historical events cannot be edited or deleted from
          the Executive Center.
        </p>
      </div>
    </div>
  );
}
