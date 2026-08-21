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
import { WORKER_LABELS } from "@/lib/worker-labels";
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
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <ScrollText aria-hidden="true" className="size-3.5" />
            AI Executive Center
          </span>
        }
        title={
          <span>
            Executive <span className="text-primary">Audit Log</span>
          </span>
        }
        description="Read-only evidence of decisions, approvals, executions, monitoring and escalations."
        backTo="/executive"
      />

      <div className="panel space-y-5 p-4 sm:p-5">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
            Event type
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "min-h-9 rounded-full border px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] transition-colors",
                  filter === f.key
                    ? "border-primary/60 bg-primary/10 text-primary shadow-[0_0_18px_-10px_var(--color-primary)]"
                    : "border-border/60 bg-surface/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {workers.length > 0 ? (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
              Worker
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {["all", ...workers].map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={worker === w}
                  onClick={() => setWorker(w)}
                  className={cn(
                    "min-h-9 rounded-full border px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] transition-colors",
                    worker === w
                      ? "border-primary/60 bg-primary/10 text-primary shadow-[0_0_18px_-10px_var(--color-primary)]"
                      : "border-border/60 bg-surface/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {w === "all" ? "All workers" : (WORKER_LABELS[w] ?? w)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="panel p-4 sm:p-5">
        {auditQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
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
          <ul className="divide-y divide-border/50">
            {visible.map((row) => {
              const t = timeOf(row.at);
              return (
                <li key={row.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      {t.time} · {t.date}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]",
                        AUDIT_CATEGORY_TONE[row.category],
                      )}
                    >
                      {row.event}
                    </Badge>
                    {row.state ? (
                      <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                        {row.state}
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-2 break-words text-sm leading-relaxed text-foreground/95">
                    {row.action}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="text-foreground/70">
                      {row.workerKey ? (WORKER_LABELS[row.workerKey] ?? row.actor) : row.actor}
                    </span>
                    {row.leadId ? (
                      <span>· Lead #{row.leadId.slice(0, 8).toUpperCase()}</span>
                    ) : null}
                    {row.approver ? <span>· Approver: {row.approver}</span> : null}
                    {row.result ? (
                      <span
                        className={cn(
                          "font-medium uppercase tracking-[0.12em]",
                          row.result === "FAILED" ? "text-destructive" : "text-foreground/70",
                        )}
                      >
                        · {row.result}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-5 border-t border-border/50 pt-4 text-[11px] leading-relaxed text-muted-foreground">
          This log is evidence and is read-only. Historical events cannot be edited or deleted from
          the Executive Center.
        </p>
      </div>
    </div>
  );
}
