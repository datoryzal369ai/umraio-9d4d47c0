import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  trend,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  trend?: { value: string; positive: boolean };
  className?: string;
}) {
  return (
    <div className={cn("panel card-interactive group relative overflow-hidden p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="rounded-xl border border-border/60 bg-surface p-2.5">
          <Icon className="size-4 text-primary" />
        </div>
        {trend ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-semibold",
              trend.positive ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
            )}
          >
            {trend.value}
          </span>
        ) : null}
      </div>
      <p className="mt-4 text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-3xl font-bold tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full bg-primary/10 blur-2xl transition-opacity group-hover:opacity-100 sm:opacity-60" />
    </div>
  );
}
