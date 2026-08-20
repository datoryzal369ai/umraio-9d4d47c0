import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BadgeCheck, Bot, Flame, Percent, TrendingUp, Wallet } from "lucide-react";

import { PageHeader } from "@/components/app/PageHeader";
import { KpiCard } from "@/components/dashboard/KpiCard";
import {
  BookingTrendChart,
  ConversionFunnelChart,
  FollowupPerformanceChart,
  LeadSourceChart,
  RevenueConversionChart,
  TopPackagesChart,
} from "@/components/dashboard/AnalyticsCharts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { myr } from "@/lib/dashboard";
import { useCopy } from "@/lib/i18n/dict";
import { shellCopy } from "@/lib/i18n/app/shell.i18n";
import {
  RANGES,
  fetchAnalytics,
  followupSeries,
  funnelSeries,
  sourceSeries,
  summary,
  topPackages,
  trendSeries,
  type AnalyticsData,
} from "@/lib/analytics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({
    meta: [
      { title: "AI Analytics — UMRAIO Autonomous AI Business Executive" },
      {
        name: "description",
        content:
          "Conversion rate, top Umrah packages, lead sources, booking trends, sales and follow-up performance in one AI analytics dashboard.",
      },
      { property: "og:title", content: "AI Analytics — UMRAIO Autonomous AI Business Executive" },
      {
        property: "og:description",
        content: "Measure AI-driven Umrah sales: conversion, packages, sources and follow-ups.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AnalyticsPage,
});

function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel p-5", className)}>
      <header className="mb-4">
        <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

function AnalyticsPage() {
  const t = useCopy(shellCopy).analytics;
  const [range, setRange] = useState<string>("180");
  const days = Number(range);
  const { data, isLoading } = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => fetchAnalytics(days),
  });

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow={t.insights}
        title={t.title}
        description={t.description}
        actions={
          <div
            role="group"
            aria-label={t.dateRange}
            className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-surface p-1"
          >
            {RANGES.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={range === option.value ? "secondary" : "ghost"}
                className="text-xs"
                onClick={() => setRange(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        }
      />

      {isLoading || !data ? <AnalyticsSkeleton /> : <AnalyticsBody data={data} days={days} t={t} />}
    </div>
  );
}

function AnalyticsBody({
  data,
  days,
  t,
}: {
  data: AnalyticsData;
  days: number;
  t: ReturnType<typeof useCopy<typeof shellCopy.en>>["analytics"];
}) {
  const stats = summary(data);
  const funnel = funnelSeries(data);
  const sources = sourceSeries(data);
  const packages = topPackages(data);
  const trend = trendSeries(data, days);
  const followups = followupSeries(data, days);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={Percent}
          label={t.kpi.conversionRate}
          value={`${stats.conversion.toFixed(1)}%`}
          hint={t.kpi.bookedOfLeads
            .replace("{booked}", String(stats.booked))
            .replace("{total}", String(stats.totalLeads))}
        />
        <KpiCard
          icon={Wallet}
          label={t.kpi.revenue}
          value={myr(stats.revenue)}
          hint={t.kpi.avgDeal.replace("{amount}", myr(Math.round(stats.avgDeal)))}
        />
        <KpiCard
          icon={Bot}
          label={t.kpi.aiHandled}
          value={`${Math.round(stats.aiShare)}%`}
          hint={t.kpi.aiRepliesSent.replace("{count}", String(stats.aiMessages))}
        />
        <KpiCard
          icon={BadgeCheck}
          label={t.kpi.followUpCompletion}
          value={`${Math.round(stats.followupRate)}%`}
          hint={t.kpi.sent.replace("{count}", String(stats.followupsSent))}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title={t.salesPerformance}
          description={t.salesPerformanceDescription}
        >
          <RevenueConversionChart data={trend} />
        </Panel>
        <Panel title={t.leadSource} description={t.leadSourceDescription}>
          <LeadSourceChart data={sources} />
          <ul className="mt-3 space-y-1.5">
            {sources.slice(0, 5).map((source) => (
              <li key={source.source} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{source.source}</span>
                <span className="font-semibold">
                  {source.leads} · {source.rate}% {t.booked}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t.conversionFunnel} description={t.conversionFunnelDescription}>
          <ConversionFunnelChart data={funnel} />
        </Panel>
        <Panel title={t.bookingTrend} description={t.bookingTrendDescription}>
          <BookingTrendChart data={trend} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t.topPackages} description={t.topPackagesDescription}>
          {packages.length ? (
            <>
              <TopPackagesChart data={packages} />
              <ul className="mt-3 space-y-1.5">
                {packages.map((pkg) => (
                  <li key={pkg.name} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-muted-foreground">{pkg.name}</span>
                    <span className="shrink-0 font-semibold">
                      {t.bookingsRevenue
                        .replace("{bookings}", String(pkg.bookings))
                        .replace("{revenue}", myr(pkg.revenue))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">{t.noBookings}</p>
          )}
        </Panel>
        <Panel title={t.followUpPerformance} description={t.followUpPerformanceDescription}>
          <FollowupPerformanceChart data={followups} />
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Flame className="size-3.5 text-primary" />
            {t.hotLeadsAttention.replace("{count}", String(stats.hotLeads))}
            <TrendingUp className="ml-auto size-3.5 text-primary" />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-36 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 rounded-2xl lg:col-span-2" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    </div>
  );
}
