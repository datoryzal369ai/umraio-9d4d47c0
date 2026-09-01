import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  Boxes,
  Bug,
  GitCommit,
  ListChecks,
  Plug,
  ShieldCheck,
  Settings2,
  TerminalSquare,
} from "lucide-react";

import { PageHeader } from "@/components/app/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDeveloperConsole } from "@/lib/developer/developer.functions";

export const Route = createFileRoute("/_authenticated/developer")({
  head: () => ({
    meta: [
      { title: "UMRAIO Developer Technical Operations Console" },
      {
        name: "description",
        content:
          "Read-only technical operations console: system health, build identity, validation, integration status, diagnostics and environment configuration.",
      },
      { property: "og:title", content: "UMRAIO Developer Technical Operations Console" },
      {
        property: "og:description",
        content: "Read-only technical operations diagnostics for the UMRAIO platform.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: DeveloperPage,
});

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "healthy" || status === "clean" || status === "configured" || status === "audited"
      ? "default"
      : status === "degraded" || status === "missing"
        ? "secondary"
        : "destructive";
  return (
    <Badge variant={tone as "default" | "secondary" | "destructive"} className="uppercase text-[10px]">
      {status}
    </Badge>
  );
}

function Panel({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Activity;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function DeveloperPage() {
  const load = useServerFn(getDeveloperConsole);
  const { data, isLoading, error } = useQuery({
    queryKey: ["developer-console"],
    queryFn: () => load(),
    retry: false,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4">
        <PageHeader title="Restricted area" description="You do not have developer access." />
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted-foreground">
          This area is limited to authorized platform engineering accounts. If you believe this is
          an error, contact the platform owner.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Developer Technical Operations Console"
        description={`Read-only diagnostics · generated ${fmt(data.generatedAt)}`}
      />

      <Tabs defaultValue="health">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="env">Environment</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
        </TabsList>

        <TabsContent value="health" className="mt-4 space-y-4">
          <Panel title="System health" icon={Activity}>
            <Row label="Application" value={<StatusPill status={data.health.application} />} />
            <Row label="Backend" value={<StatusPill status={data.health.backend} />} />
            <Row label="Database connectivity" value={<StatusPill status={data.health.database} />} />
            <Row label="Database latency" value={`${data.health.databaseLatencyMs} ms`} />
            <Row label="Timestamp" value={fmt(data.health.timestamp)} />
          </Panel>
          <Panel title="Validation" icon={ListChecks}>
            <Row label="Tests passed" value={data.validation.testsPassed} />
            <Row label="Tests failed" value={data.validation.testsFailed} />
            <Row label="Tests skipped" value={data.validation.testsSkipped} />
            <Row label="Typecheck" value={<StatusPill status={data.validation.typecheck} />} />
            <Row label="Validated at" value={fmt(data.validation.validatedAt)} />
          </Panel>
        </TabsContent>

        <TabsContent value="build" className="mt-4">
          <Panel title="Build & deployment" icon={GitCommit}>
            <Row
              label="Commit"
              value={<span className="font-mono">{data.build.commitShort ?? "unknown"}</span>}
            />
            <Row label="Build time" value={fmt(data.build.buildTime)} />
            <Row label="Environment" value={data.build.environment} />
            <Row label="Deployment" value={data.build.deployment} />
            <Row label="Version" value={data.build.version} />
          </Panel>
        </TabsContent>

        <TabsContent value="integrations" className="mt-4">
          <Panel title="Integration health" icon={Plug}>
            {data.integrations.map((item) => (
              <div key={item.key} className="border-b border-border/60 py-2 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">{item.label}</span>
                  <div className="flex items-center gap-2">
                    <StatusPill status={item.state} />
                    <StatusPill status={item.status} />
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
              </div>
            ))}
          </Panel>
        </TabsContent>

        <TabsContent value="diagnostics" className="mt-4">
          <Panel title="Error diagnostics (sanitized)" icon={Bug}>
            {data.errors.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent failures recorded.</p>
            ) : (
              data.errors.map((e) => (
                <div key={e.id} className="border-b border-border/60 py-2 text-sm last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="destructive" className="text-[10px]">
                      {e.errorClass}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">{e.correlationId}</span>
                    <span className="text-xs text-muted-foreground">{fmt(e.occurredAt)}</span>
                  </div>
                  <p className="mt-1 text-xs text-foreground">{e.message}</p>
                </div>
              ))
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="jobs" className="mt-4">
          <Panel title="Background jobs" icon={Boxes}>
            {data.jobs.map((job) => (
              <div key={job.jobType} className="border-b border-border/60 py-2 last:border-0">
                <div className="text-sm font-medium text-foreground">{job.jobType}</div>
                <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>Queue depth: {job.queueDepth}</span>
                  <span>Retries: {job.retryCount}</span>
                  <span>Stuck: {job.stuckCount}</span>
                  <span>Last execution: {fmt(job.lastExecution)}</span>
                </div>
              </div>
            ))}
          </Panel>
        </TabsContent>

        <TabsContent value="env" className="mt-4">
          <Panel title="Environment configuration (names only)" icon={Settings2}>
            {data.env.map((entry) => (
              <Row
                key={entry.name}
                label={<span className="font-mono text-xs">{entry.name}</span> as never}
                value={<StatusPill status={entry.state} />}
              />
            ))}
          </Panel>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <Panel title="Security status indicators (audit view)" icon={ShieldCheck}>
            {data.security.map((s) => (
              <div key={s.key} className="border-b border-border/60 py-2 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">{s.label}</span>
                  <StatusPill status={s.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.detail}</p>
              </div>
            ))}
          </Panel>
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <Panel title="Development tasks" icon={TerminalSquare}>
            {data.tasks.map((t) => (
              <div key={t.id} className="border-b border-border/60 py-2 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">{t.task}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {t.priority}
                    </Badge>
                    <StatusPill status={t.status} />
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{fmt(t.updatedAt)}</p>
              </div>
            ))}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
