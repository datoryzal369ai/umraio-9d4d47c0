import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Crosshair,
  Flame,
  Handshake,
  Percent,
  Target,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { myr, type DashboardData } from "@/lib/dashboard";
import {
  buildEliteNextActions,
  computeEliteMetrics,
  type EliteNextAction,
} from "@/lib/sales/elite/elite-metrics.core";
import { cn } from "@/lib/utils";

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-3.5 text-primary" aria-hidden="true" />
        <span className="text-[11px] uppercase tracking-[0.14em]">{label}</span>
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

const priorityTone: Record<EliteNextAction["priority"], string> = {
  critical: "bg-destructive/15 text-destructive",
  high: "bg-chart-4/15 text-chart-4",
  normal: "bg-muted text-muted-foreground",
};

export function SalesEliteCard({ data }: { data: DashboardData }) {
  const metrics = computeEliteMetrics({
    leads: data.leads,
    followups: data.followups,
    bookings: data.bookings,
    conversations: data.conversations,
  });
  const actions = buildEliteNextActions({
    leads: data.leads,
    followups: data.followups,
    conversations: data.conversations,
    metrics,
  });

  return (
    <section className="panel-elite card-interactive-gold space-y-5 p-5" aria-labelledby="sales-elite-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl border border-gold/40 bg-gold/10">
            <Target className="size-4 text-gold" aria-hidden="true" />
          </span>
          <div>
            <h2 id="sales-elite-heading" className="text-champagne text-sm font-semibold tracking-tight">
              AI SALES ELITE™
            </h2>
            <p className="text-xs text-muted-foreground">
              Elite autonomous sales &amp; closing intelligence
            </p>
          </div>
        </div>
        <Badge className="gap-1.5 bg-success/15 text-success">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-success" />
          </span>
          ACTIVE
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Users} label="Leads engaged" value={String(metrics.leadsEngaged)} />
        <Metric icon={UserCheck} label="Qualified" value={String(metrics.qualifiedLeads)} />
        <Metric icon={Flame} label="High intent" value={String(metrics.highIntentLeads)} />
        <Metric icon={Handshake} label="In closing" value={String(metrics.conversationsInClosing)} />
        <Metric icon={Crosshair} label="Follow-ups due" value={String(metrics.followupsDue)} />
        <Metric icon={TrendingUp} label="Sales won" value={String(metrics.salesWon)} />
        <Metric icon={Percent} label="Conversion rate" value={`${metrics.conversionRate}%`} />
        <Metric
          icon={TrendingUp}
          label="Revenue influenced"
          value={myr(metrics.revenueInfluencedMyr)}
        />
      </div>

      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Next best actions
        </p>
        <ul className="space-y-2">
          {actions.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-surface px-4 py-3"
            >
              <span className="text-sm">{a.label}</span>
              <Badge className={cn("shrink-0 text-[10px] uppercase", priorityTone[a.priority])}>
                {a.priority}
              </Badge>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/sales-elite">
            Open AI SALES ELITE™ <ArrowRight className="ml-1 size-3.5" aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/conversations">Review conversations</Link>
        </Button>
      </div>
    </section>
  );
}
