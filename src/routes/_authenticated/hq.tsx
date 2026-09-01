import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  Building2,
  KeyRound,
  ShieldCheck,
  Users,
  Gauge,
  ScrollText,
} from "lucide-react";

import { PageHeader } from "@/components/app/PageHeader";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getHqAgencyDetail, getHqPlatform } from "@/lib/hq/hq.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/hq")({
  head: () => ({
    meta: [
      { title: "UMRAIO Founder HQ Control Center" },
      {
        name: "description",
        content:
          "Founder-only command center: platform metrics, agencies, users, login activity, audit trail and security posture.",
      },
      { property: "og:title", content: "UMRAIO Founder HQ Control Center" },
      {
        property: "og:description",
        content: "Platform-owner command center for agencies, users, activity and security.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: HqPage,
});

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}

function roleBadge(role: string) {
  const founder = role === "platform_owner";
  return (
    <Badge key={role} variant={founder ? "default" : "outline"}>
      {founder ? "Founder · platform_owner" : role}
    </Badge>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface">
      <h2 className="border-b border-border/60 px-4 py-3 text-sm font-semibold">{title}</h2>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function HqPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const fetchPlatform = useServerFn(getHqPlatform);
  const fetchDetail = useServerFn(getHqAgencyDetail);

  const platform = useQuery({
    queryKey: ["hq-platform"],
    queryFn: () => fetchPlatform(),
    retry: false,
  });

  const detail = useQuery({
    queryKey: ["hq-agency", selected],
    enabled: Boolean(selected),
    queryFn: () => fetchDetail({ data: { agencyId: selected! } }),
    retry: false,
  });

  const data = platform.data;

  const filteredUsers = useMemo(() => {
    const q = userFilter.trim().toLowerCase();
    const list = data?.users ?? [];
    if (!q) return list;
    return list.filter((u) =>
      [u.name, u.email ?? "", u.agencyName, u.roles.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [data?.users, userFilter]);

  const filteredActivity = useMemo(() => {
    const q = activityFilter.trim().toLowerCase();
    const list = data?.activity ?? [];
    if (!q) return list;
    return list.filter((a) =>
      [a.userName, a.agencyName, a.action, a.entity ?? "", a.entityId ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [data?.activity, activityFilter]);

  if (platform.isError) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-lg font-semibold">Restricted area</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          UMRAIO Founder HQ is available to the platform owner only.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Founder only"
        title="UMRAIO Founder HQ Control Center"
        description="Platform-wide read-only command center: agencies, users, login activity, audit trail and security posture."
      />

      {platform.isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="flex w-full flex-nowrap justify-start gap-2 overflow-x-auto px-1 py-1 sm:flex-wrap sm:gap-1 sm:overflow-visible">
            <TabsTrigger className="shrink-0 px-4 py-2 sm:px-3 sm:py-1" value="overview">Overview</TabsTrigger>
            <TabsTrigger className="shrink-0 px-4 py-2 sm:px-3 sm:py-1" value="agencies">Agencies</TabsTrigger>
            <TabsTrigger className="shrink-0 px-4 py-2 sm:px-3 sm:py-1" value="users">Users</TabsTrigger>
            <TabsTrigger className="shrink-0 px-4 py-2 sm:px-3 sm:py-1" value="logins">Login activity</TabsTrigger>
            <TabsTrigger className="shrink-0 px-4 py-2 sm:px-3 sm:py-1" value="audit">Activity audit</TabsTrigger>
            <TabsTrigger className="shrink-0 px-4 py-2 sm:px-3 sm:py-1" value="security">Security</TabsTrigger>
          </TabsList>

          {/* ── OVERVIEW ─────────────────────────────────────────────── */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard icon={Building2} label="Total agencies" value={String(data.stats.totalAgencies)} />
              <KpiCard icon={Users} label="Total users" value={String(data.stats.totalUsers)} />
              <KpiCard
                icon={Gauge}
                label="Active agencies"
                value={String(data.stats.activeAgencies)}
                hint="Presence in the last 7 days"
              />
              <KpiCard icon={Building2} label="Trial agencies" value={String(data.stats.trialAgencies)} />
              <KpiCard
                icon={KeyRound}
                label="Active subscriptions"
                value={String(data.stats.activeSubscriptions)}
                hint="Agencies on a paid effective plan"
              />
              <KpiCard
                icon={Users}
                label="Recently active users"
                value={String(data.stats.recentlyActiveUsers)}
                hint="Last 7 days"
              />
              <KpiCard
                icon={Activity}
                label="Recent logins"
                value={String(data.stats.recentLogins)}
                hint="Last 7 days"
              />
            </div>
          </TabsContent>

          {/* ── AGENCIES ─────────────────────────────────────────────── */}
          <TabsContent value="agencies" className="space-y-6">
            <Panel title="Agencies">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Agency</th>
                    <th className="px-4 py-3">Plan</th>
                    <th className="px-4 py-3">Plan status</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Users</th>
                    <th className="px-4 py-3">Last activity</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {data.agencies.map((a) => (
                    <tr
                      key={a.id}
                      className={cn("border-t border-border/60", selected === a.id && "bg-muted/40")}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 font-medium">
                          <Building2 aria-hidden="true" className="size-4 text-muted-foreground" />
                          {a.name}
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{a.id}</p>
                        <p className="text-xs text-muted-foreground">{a.ownerEmail ?? ""}</p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{a.plan}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {a.planSource ?? "Not available"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtDate(a.createdAt)}</td>
                      <td className="px-4 py-3">{a.userCount}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {fmtDate(a.lastActivityAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant={selected === a.id ? "secondary" : "outline"}
                          onClick={() => setSelected(a.id)}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {data.agencies.length === 0 && (
                    <tr>
                      <td className="px-4 py-6 text-muted-foreground" colSpan={7}>
                        No agencies yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>

            {selected && (
              <section className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-xl border border-border bg-surface p-4">
                  <h2 className="mb-3 text-sm font-semibold">Agency users</h2>
                  {detail.isLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : (
                    <ul className="space-y-3">
                      {(detail.data?.users ?? []).map((u) => (
                        <li key={u.id} className="border-b border-border/50 pb-3 last:border-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{u.name}</span>
                            {u.roles.map(roleBadge)}
                          </div>
                          <p className="text-xs text-muted-foreground">{u.email ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">
                            Last active: {fmtDate(u.lastSeenAt)}
                          </p>
                        </li>
                      ))}
                      {(detail.data?.users ?? []).length === 0 && (
                        <li className="text-sm text-muted-foreground">No users.</li>
                      )}
                    </ul>
                  )}
                </div>

                <div className="rounded-xl border border-border bg-surface p-4">
                  <h2 className="mb-3 text-sm font-semibold">Recent session events</h2>
                  {detail.isLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {(detail.data?.activity ?? []).map((e) => (
                        <li key={e.id} className="flex items-center justify-between gap-3">
                          <span className="truncate">{e.userName}</span>
                          <Badge variant="secondary">{e.eventType}</Badge>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {fmtDate(e.occurredAt)}
                          </span>
                        </li>
                      ))}
                      {(detail.data?.activity ?? []).length === 0 && (
                        <li className="text-muted-foreground">No session events recorded.</li>
                      )}
                    </ul>
                  )}
                </div>
              </section>
            )}
          </TabsContent>

          {/* ── USERS ────────────────────────────────────────────────── */}
          <TabsContent value="users" className="space-y-4">
            <Input
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              placeholder="Filter by name, email, agency or role"
              className="max-w-sm"
            />
            <Panel title={`Platform users (${filteredUsers.length})`}>
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Agency</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Activity status</th>
                    <th className="px-4 py-3">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => {
                    const active =
                      u.lastSeenAt &&
                      Date.now() - new Date(u.lastSeenAt).getTime() < 7 * 24 * 3600 * 1000;
                    return (
                      <tr key={u.id} className="border-t border-border/60">
                        <td className="px-4 py-3 font-medium">{u.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{u.email ?? "—"}</td>
                        <td className="px-4 py-3">{u.agencyName}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {u.roles.length ? u.roles.map(roleBadge) : "—"}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={active ? "default" : "secondary"}>
                            {active ? "Recently active" : "Idle"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(u.lastSeenAt)}</td>
                      </tr>
                    );
                  })}
                  {filteredUsers.length === 0 && (
                    <tr>
                      <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                        No users match this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          </TabsContent>

          {/* ── LOGIN ACTIVITY ───────────────────────────────────────── */}
          <TabsContent value="logins" className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Session events recorded by the application. IP and device data are not recorded and
              are therefore not shown. Session keys are masked.
            </p>
            <Panel title={`Session events (${data.logins.length})`}>
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Agency</th>
                    <th className="px-4 py-3">Event type</th>
                    <th className="px-4 py-3">Session key</th>
                    <th className="px-4 py-3">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.logins.map((e) => (
                    <tr key={e.id} className="border-t border-border/60">
                      <td className="px-4 py-3 font-medium">{e.userName}</td>
                      <td className="px-4 py-3 text-muted-foreground">{e.userEmail ?? "—"}</td>
                      <td className="px-4 py-3">{e.agencyName}</td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{e.eventType}</Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {e.sessionKey}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtDate(e.occurredAt)}</td>
                    </tr>
                  ))}
                  {data.logins.length === 0 && (
                    <tr>
                      <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                        No session events recorded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          </TabsContent>

          {/* ── ACTIVITY AUDIT ───────────────────────────────────────── */}
          <TabsContent value="audit" className="space-y-4">
            <Input
              value={activityFilter}
              onChange={(e) => setActivityFilter(e.target.value)}
              placeholder="Filter by agency, user, action or entity"
              className="max-w-sm"
            />
            <Panel title={`Recent activity (${filteredActivity.length})`}>
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Agency</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Entity</th>
                    <th className="px-4 py-3">Entity ID</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActivity.map((a) => (
                    <tr key={a.id} className="border-t border-border/60">
                      <td className="px-4 py-3 text-muted-foreground">{fmtDate(a.createdAt)}</td>
                      <td className="px-4 py-3 font-medium">{a.userName}</td>
                      <td className="px-4 py-3">{a.agencyName}</td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{a.action}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{a.entity ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                        {a.entityId ?? "—"}
                      </td>
                    </tr>
                  ))}
                  {filteredActivity.length === 0 && (
                    <tr>
                      <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                        No activity matches this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          </TabsContent>

          {/* ── SECURITY ─────────────────────────────────────────────── */}
          <TabsContent value="security" className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Read-only posture summary. No security setting can be changed from this screen.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {data.security.map((c) => (
                <div key={c.key} className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="mt-0.5 size-4 text-primary" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{c.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
                      <Badge variant="outline" className="mt-2">
                        Verified during security audit
                      </Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ScrollText className="size-3.5" aria-hidden="true" />
              Statuses reflect the recorded security audit, not a live runtime probe.
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
