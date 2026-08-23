import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, ScrollText, UserCheck, PackageCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { IslamicReviewQueue } from "@/components/islamic/IslamicReviewQueue";
import { Skeleton } from "@/components/ui/skeleton";
import {
  REVIEW_STATUS_LABEL,
  SEVERITY_TONE,
  fetchExpertReviews,
  fetchIslamicPolicies,
  fetchPackageReviewStatus,
  fetchPolicyDecisions,
} from "@/lib/islamic-governance";
import { settingsCopy } from "@/lib/i18n/app/settings.i18n";
import { useCopy } from "@/lib/i18n/dict";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/governance")({
  head: () => ({
    meta: [
      { title: "Islamic Implementation Layer — UMRAIO" },
      {
        name: "description",
        content:
          "Review the governance policies, halal baseline statuses and expert-review requests that constrain UMRAIO's autonomous actions.",
      },
      { property: "og:title", content: "Islamic Implementation Layer — UMRAIO" },
      {
        property: "og:description",
        content: "Governed AI: policy register, audit trail and qualified human oversight.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GovernancePage,
});

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof ShieldCheck;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <header className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 rounded-lg border border-border p-2 text-primary">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function GovernancePage() {
  const copy = useCopy(settingsCopy).governance;
  const policies = useQuery({ queryKey: ["islamic-policies"], queryFn: fetchIslamicPolicies });
  const decisions = useQuery({ queryKey: ["islamic-decisions"], queryFn: () => fetchPolicyDecisions() });
  const reviews = useQuery({ queryKey: ["islamic-reviews"], queryFn: () => fetchExpertReviews() });
  const packages = useQuery({ queryKey: ["package-review-status"], queryFn: fetchPackageReviewStatus });

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
        <h1 className="text-lg font-semibold text-foreground">{copy.hero.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {copy.hero.body.split("{not}")[0]}
          <strong className="text-foreground">{copy.hero.bodyNot}</strong>
          {copy.hero.body.split("{not}")[1]}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {copy.hero.note}
        </p>
      </div>

      <IslamicReviewQueue />

      <Section
        icon={ScrollText}
        title={copy.policyRegister.title}
        description={copy.policyRegister.description}
      >
        {policies.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !policies.data?.length ? (
          <p className="text-sm text-muted-foreground">{copy.policyRegister.empty}</p>
        ) : (
          <ul className="space-y-3">
            {policies.data.map((p) => (
              <li key={p.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {p.code} v{p.version}
                  </span>
                  <Badge variant="outline" className={cn(SEVERITY_TONE[p.severity])}>
                    {p.severity.replace("_", " ")}
                  </Badge>
                  <Badge variant="outline">{p.scope.replace("_", " ")}</Badge>
                  {p.requires_human_review ? (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-400">
                      {copy.policyRegister.qualifiedReview}
                    </Badge>
                  ) : null}
                  <Badge variant="outline">{p.agency_id ? copy.policyRegister.agency : copy.policyRegister.platform}</Badge>
                </div>
                <p className="mt-2 text-sm font-medium text-foreground">{p.principle}</p>
                <p className="mt-1 text-sm text-muted-foreground">{p.rule_text}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {copy.policyRegister.sourceLine
                    .replace("{source}", p.source)
                    .replace("{authority}", p.authority)
                    .replace("{date}", new Date(p.effective_from).toLocaleDateString())}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        icon={PackageCheck}
        title={copy.halalBaseline.title}
        description={copy.halalBaseline.description}
      >
        {packages.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !packages.data?.length ? (
          <p className="text-sm text-muted-foreground">{copy.halalBaseline.empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {packages.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate text-sm text-foreground">{p.name}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    p.halal_review_status === "REVIEWED"
                      ? "border-primary/40 text-primary"
                      : p.halal_review_status === "REJECTED"
                        ? "border-destructive/40 text-destructive"
                        : "border-amber-500/40 text-amber-400",
                  )}
                >
                  {REVIEW_STATUS_LABEL[p.halal_review_status] ?? p.halal_review_status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        icon={UserCheck}
        title={copy.expertReviews.title}
        description={copy.expertReviews.description}
      >
        {reviews.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !reviews.data?.length ? (
          <p className="text-sm text-muted-foreground">{copy.expertReviews.empty}</p>
        ) : (
          <ul className="space-y-3">
            {reviews.data.map((r) => (
              <li key={r.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{r.title}</span>
                  <Badge variant="outline" className="border-amber-500/40 text-amber-400">
                    {String((r.meta as { review_status?: string })?.review_status ?? "PENDING")}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{r.body}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {copy.expertReviews.raisedLine.replace("{date}", new Date(r.created_at).toLocaleString())}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        icon={ShieldCheck}
        title={copy.audit.title}
        description={copy.audit.description}
      >
        {decisions.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !decisions.data?.length ? (
          <p className="text-sm text-muted-foreground">{copy.audit.empty}</p>
        ) : (
          <ul className="space-y-2">
            {decisions.data.map((d) => {
              const meta = d.meta as {
                policy_outcome?: string;
                policy_code?: string;
                policy_version?: number;
                authority?: string;
              };
              return (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span className="min-w-0 text-foreground">{d.action}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {meta.policy_code ? (
                      <span className="font-mono">
                        {meta.policy_code} v{meta.policy_version ?? 1}
                      </span>
                    ) : null}
                    <Badge variant="outline">{meta.policy_outcome ?? "—"}</Badge>
                    {new Date(d.created_at).toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
