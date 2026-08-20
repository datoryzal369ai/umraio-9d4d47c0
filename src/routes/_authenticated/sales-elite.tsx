import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowRight,
  Crosshair,
  Flame,
  Handshake,
  Percent,
  ShieldAlert,
  Target,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";

import { PageHeader } from "@/components/app/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { myr } from "@/lib/dashboard";
import { eliteSalesDesk } from "@/lib/sales/elite/elite-desk.functions";
import type { EliteDeskItem } from "@/lib/sales/elite/elite-desk.server";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/sales-elite")({
  head: () => ({
    meta: [
      { title: "AI SALES ELITE™ — UMRAIO Sales Intelligence" },
      {
        name: "description",
        content:
          "Live elite sales intelligence: lead state, buyer psychology, objections, closing mode and the single next best action for every active Umrah conversation.",
      },
      { property: "og:title", content: "AI SALES ELITE™ — UMRAIO Sales Intelligence" },
      {
        property: "og:description",
        content: "Elite autonomous sales and closing intelligence for your Umrah agency.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SalesElitePage,
});

const bandTone: Record<string, string> = {
  high: "bg-success/15 text-success",
  medium: "bg-chart-4/15 text-chart-4",
  low: "bg-muted text-muted-foreground",
};

const priorityTone: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive",
  high: "bg-chart-4/15 text-chart-4",
  normal: "bg-muted text-muted-foreground",
};

function Metric({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
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

function DeskRow({ item }: { item: EliteDeskItem }) {
  const p = item.read.psychology;
  return (
    <li className="rounded-xl border border-border/60 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{item.leadName}</span>
        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
          {item.read.state.replaceAll("_", " ")}
        </Badge>
        {item.read.escalate ? (
          <Badge className="gap-1 bg-destructive/15 text-[10px] uppercase text-destructive">
            <ShieldAlert className="size-3" aria-hidden="true" /> Human needed
          </Badge>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          score {item.score} · confidence {Math.round(item.read.confidence * 100)}%
        </span>
      </div>

      <p className="mt-2 text-sm">
        <span className="font-medium text-primary">{item.read.action.replaceAll("_", " ")}</span>{" "}
        — {item.read.rationale}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wider">
        <Badge className={cn(bandTone[p.readiness])}>readiness {p.readiness}</Badge>
        <Badge className={cn(bandTone[p.trust])}>trust {p.trust}</Badge>
        <Badge className={cn(bandTone[p.urgency])}>urgency {p.urgency}</Badge>
        <Badge className={cn(bandTone[p.priceSensitivity])}>price {p.priceSensitivity}</Badge>
        {item.read.closingMode !== "NONE" ? (
          <Badge className="bg-primary/15 text-primary">close: {item.read.closingMode}</Badge>
        ) : null}
      </div>

      {item.read.objectionFocus ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Objection to resolve: <span className="text-foreground">{item.read.objectionFocus}</span>
        </p>
      ) : null}
      {item.missing.length ? (
        <p className="mt-1 text-xs text-muted-foreground">Still missing: {item.missing.join(", ")}</p>
      ) : null}
      {item.read.followUp ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Follow up in {item.read.followUp.hours}h — {item.read.followUp.angle}
        </p>
      ) : null}

      {item.handoffBrief ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-primary">
            Human handoff brief
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed">
            {item.handoffBrief}
          </pre>
        </details>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/conversations/$conversationId" params={{ conversationId: item.conversationId }}>
            Open conversation <ArrowRight className="ml-1 size-3.5" aria-hidden="true" />
          </Link>
        </Button>
        {item.leadId ? (
          <Button asChild size="sm" variant="ghost">
            <Link to="/leads/$leadId" params={{ leadId: item.leadId }}>
              View lead
            </Link>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function SalesElitePage() {
  const load = useServerFn(eliteSalesDesk);
  const desk = useQuery({ queryKey: ["elite-desk"], queryFn: () => load({ data: undefined }) });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        backTo="/executive"
        backLabel="Back to Command Center"
        eyebrow="AI Workforce"
        title={<span className="text-champagne">AI SALES ELITE™</span>}
        description="Elite autonomous sales & closing intelligence — live from your own pipeline, never estimated."
      />


      {desk.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : desk.error ? (
        <p className="panel p-5 text-sm text-destructive">
          Sales intelligence could not be loaded. Please try again.
        </p>
      ) : desk.data ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={Users} label="Leads engaged" value={String(desk.data.metrics.leadsEngaged)} />
            <Metric icon={UserCheck} label="Qualified" value={String(desk.data.metrics.qualifiedLeads)} />
            <Metric icon={Flame} label="High intent" value={String(desk.data.metrics.highIntentLeads)} />
            <Metric
              icon={Handshake}
              label="In closing"
              value={String(desk.data.metrics.conversationsInClosing)}
            />
            <Metric icon={Crosshair} label="Follow-ups due" value={String(desk.data.metrics.followupsDue)} />
            <Metric icon={TrendingUp} label="Sales won" value={String(desk.data.metrics.salesWon)} />
            <Metric icon={Percent} label="Conversion rate" value={`${desk.data.metrics.conversionRate}%`} />
            <Metric
              icon={Target}
              label="Pipeline influenced"
              value={myr(desk.data.metrics.revenueInfluencedMyr)}
            />
          </section>

          <section className="panel space-y-3 p-5" aria-labelledby="nba-heading">
            <h2 id="nba-heading" className="text-sm font-semibold tracking-tight">
              Next best actions
            </h2>
            <ul className="space-y-2">
              {desk.data.nextActions.map((a) => (
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
          </section>

          <section className="panel space-y-3 p-5" aria-labelledby="desk-heading">
            <h2 id="desk-heading" className="text-sm font-semibold tracking-tight">
              Live conversation intelligence
            </h2>
            {desk.data.items.length ? (
              <ul className="space-y-3">
                {desk.data.items.map((item) => (
                  <DeskRow key={item.conversationId} item={item} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {desk.data.empty
                  ? "No leads or conversations yet. AI SALES ELITE™ activates the moment your first enquiry arrives."
                  : "No active conversations with customer messages yet — nothing to read into."}
              </p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
