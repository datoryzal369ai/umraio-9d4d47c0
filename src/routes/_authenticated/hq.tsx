import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2 } from "lucide-react";

import { PageHeader } from "@/components/app/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getHqAgencyDetail, getHqOverview } from "@/lib/hq/hq.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/hq")({
  head: () => ({
    meta: [
      { title: "UMRAIO HQ — Agencies & users" },
      {
        name: "description",
        content:
          "Platform-owner visibility across UMRAIO agencies, their users, roles, presence and recent login activity.",
      },
      { property: "og:title", content: "UMRAIO HQ — Agencies & users" },
      { property: "og:description", content: "Platform-owner view of agencies, users and activity." },
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

function HqPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const fetchOverview = useServerFn(getHqOverview);
  const fetchDetail = useServerFn(getHqAgencyDetail);

  const overview = useQuery({
    queryKey: ["hq-overview"],
    queryFn: () => fetchOverview(),
    retry: false,
  });

  const detail = useQuery({
    queryKey: ["hq-agency", selected],
    enabled: Boolean(selected),
    queryFn: () => fetchDetail({ data: { agencyId: selected! } }),
    retry: false,
  });

  if (overview.isError) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-lg font-semibold">Restricted area</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          UMRAIO HQ is available to the platform owner only.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="UMRAIO HQ"
        description="Platform-owner visibility: agencies, users, roles and recent login activity."
      />

      {overview.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <section className="rounded-xl border border-border bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Agency</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Users</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {(overview.data?.agencies ?? []).map((a) => (
                  <tr
                    key={a.id}
                    className={cn(
                      "border-t border-border/60",
                      selected === a.id && "bg-muted/40",
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium">
                        <Building2 aria-hidden="true" className="size-4 text-muted-foreground" />
                        {a.name}
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{a.id}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{a.plan}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div>{a.ownerName ?? "—"}</div>
                      <p className="text-xs text-muted-foreground">{a.ownerEmail ?? ""}</p>
                    </td>
                    <td className="px-4 py-3">{a.userCount}</td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(a.createdAt)}</td>
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
                {(overview.data?.agencies ?? []).length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                      No agencies yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selected && (
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold">Users</h2>
            {detail.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <ul className="space-y-3">
                {(detail.data?.users ?? []).map((u) => (
                  <li key={u.id} className="border-b border-border/50 pb-3 last:border-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{u.name}</span>
                      {u.roles.map((r) => (
                        <Badge key={r} variant="outline">
                          {r}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">{u.email ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      Last active: {fmtDate(u.lastSeenAt)}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">{u.id}</p>
                  </li>
                ))}
                {(detail.data?.users ?? []).length === 0 && (
                  <li className="text-sm text-muted-foreground">No users.</li>
                )}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold">Recent activity</h2>
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
                  <li className="text-muted-foreground">No login activity recorded.</li>
                )}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
