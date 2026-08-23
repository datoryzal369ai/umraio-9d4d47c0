import { useEffect, useState } from "react";
import { Link, createFileRoute, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, CreditCard, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LanguageSelector } from "@/components/app/LanguageSelector";
import { PaymentTestModeBanner } from "@/components/settings/PaymentTestModeBanner";
import { UsagePanel } from "@/components/settings/UsagePanel";
import { useAuth } from "@/hooks/useAuth";
import {
  getBillingStatus,
  getCheckoutAvailability,
  openBillingPortal,
  prepareCheckout,
} from "@/lib/billing/checkout.functions";
import { publicPlans, resolveDisplayPlan } from "@/lib/billing/pricing.core";
import {
  PRICING_SECTION_COPY,
  localizedPlanPrice,
  localizedReferencePrice,
  localizedSavings,
  planCopy,
} from "@/lib/billing/pricing.i18n";
import { useCopy } from "@/lib/i18n/dict";
import { settingsCopy } from "@/lib/i18n/app/settings.i18n";
import { useLocale } from "@/lib/i18n/locale";
import { fetchAgency, fetchSettings, updateSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";


export const Route = createFileRoute("/_authenticated/settings/subscription")({
  validateSearch: (search: Record<string, unknown>) => ({
    checkout:
      search["checkout"] === "success" || search["checkout"] === "cancelled"
        ? (search["checkout"] as "success" | "cancelled")
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Subscription & Plan — UMRAIO" },
      {
        name: "description",
        content:
          "Review your UMRAIO plan, seats and renewal date, and switch between Trial, Growth and Scale.",
      },
      { property: "og:title", content: "Subscription & Plan — UMRAIO" },
      { property: "og:description", content: "Plan, seats, usage and renewal for your agency." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SubscriptionPage,
});

function SubscriptionPage() {
  const queryClient = useQueryClient();
  const { locale } = useLocale();
  const copy = PRICING_SECTION_COPY[locale];
  const settingsAi = useCopy(settingsCopy).ai;
  const { data: agency } = useQuery({ queryKey: ["agency"], queryFn: fetchAgency });
  const { data: settings, isLoading } = useQuery({
    queryKey: ["agency-settings", agency?.id],
    queryFn: () => fetchSettings(agency!.id),
    enabled: Boolean(agency?.id),
  });

  const { user } = useAuth();
  const startCheckout = useServerFn(prepareCheckout);
  const checkAvailability = useServerFn(getCheckoutAvailability);

  const { data: availability } = useQuery({
    queryKey: ["checkout-availability"],
    queryFn: () => checkAvailability({}),
    staleTime: 5 * 60 * 1000,
  });
  const checkoutAvailable = availability?.available === true;
  // Server-authoritative subscription state. Entitlement is written only by the
  // signature-verified Stripe webhook; this is a read-only view of the result.
  const readBillingStatus = useServerFn(getBillingStatus);
  const { checkout } = useSearch({ from: "/_authenticated/settings/subscription" });
  const [awaitingWebhook, setAwaitingWebhook] = useState(checkout === "success");
  const { data: billing } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => readBillingStatus({}),
    refetchInterval: awaitingWebhook ? 3000 : false,
  });

  useEffect(() => {
    if (checkout === "success") toast.success(copy.checkoutSuccess);
    if (checkout === "cancelled") toast.info(copy.checkoutCancelled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout]);

  useEffect(() => {
    if (billing?.paid) setAwaitingWebhook(false);
  }, [billing?.paid]);

  const manageBilling = useServerFn(openBillingPortal);
  const portal = useMutation({
    mutationFn: async () => manageBilling({}),
    onSuccess: (result) => {
      if ("url" in result) window.location.href = result.url;
      else toast.error(copy.portalUnavailable);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const choose = useMutation({
    mutationFn: async (plan: string) => {
      if (!settings) throw new Error(settingsAi.toasts.settingsNotLoaded);
      const target = publicPlans().find((item) => item.id === plan);

      // The selection itself is only a preference — never proof of payment.
      await updateSettings(settings.id, {
        plan,
        seats: target?.seats ?? settings.seats,
      });

      // The server decides the price and currency; the browser never sends one.
      const prepared = await startCheckout({ data: { plan } });
      if (prepared.status !== "ready") return prepared;

      // Redirect to the Stripe-hosted checkout. Reaching it grants nothing —
      // entitlement is written only by the verified webhook.
      window.location.href = prepared.url;
      return prepared;
    },
    onSuccess: (result) => {
      if (result && result.status === "ready") {
        toast.info(copy.openingCheckout);
      } else {
        toast.success(copy.activationRequested);
      }
      queryClient.invalidateQueries({ queryKey: ["agency-settings"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading || !settings) return <Skeleton className="h-[420px] rounded-2xl" />;

  const current = resolveDisplayPlan(settings.plan);

  return (
    <div className="space-y-6">
      <PaymentTestModeBanner mode={availability?.mode ?? null} />
      <UsagePanel />


      <section className="panel space-y-4 p-5">

        <header className="flex items-start gap-3">
          <div className="rounded-xl border border-border/60 bg-surface p-2.5">
            <CreditCard className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight">
              {copy.selectedPlanHeading}
            </h2>
            <p className="text-xs text-muted-foreground">{copy.selectedPlanNote}</p>
          </div>
        </header>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {copy.selectedPlanHeading}
            </p>
            <p className="mt-1 font-display text-lg font-bold">{current.name}</p>
            <Badge variant={billing?.paid ? "default" : "secondary"} className="mt-2 capitalize">
              {billing?.paid ? (billing.status ?? "active") : settings.plan_status}
            </Badge>
            <p className="mt-2 text-xs text-muted-foreground">
              {billing?.paid
                ? copy.subscriptionActive
                : awaitingWebhook
                  ? copy.subscriptionPending
                  : copy.noActiveSubscription}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{copy.seats}</p>
            <p className="mt-1 flex items-center gap-2 font-display text-lg font-bold">
              <Users className="size-4 text-primary" />
              {settings.seats}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{copy.renews}</p>
            <p className="mt-1 font-display text-lg font-bold">
              {billing?.currentPeriodEnd
                ? new Date(billing.currentPeriodEnd).toLocaleDateString()
                : settings.renews_at
                  ? new Date(settings.renews_at).toLocaleDateString()
                  : "—"}
            </p>
          </div>
        </div>

        {billing?.paid ? (
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
            <p className="text-sm font-medium">{copy.activationNextStep}</p>
            <Button asChild size="sm" className="mt-3">
              <Link to="/settings/whatsapp">{copy.connectWhatsapp}</Link>
            </Button>
          </div>
        ) : null}

        {checkoutAvailable ? (
          <Button
            variant="outline"
            size="sm"
            disabled={portal.isPending}
            onClick={() => portal.mutate()}
          >
            <CreditCard className="size-4" />
            {copy.manageBilling}
          </Button>
        ) : null}
      </section>

      <section className="panel space-y-4 p-5">
        <header className="flex items-start gap-3">
          <div className="rounded-xl border border-border/60 bg-surface p-2.5">
            <Sparkles className="size-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="font-display text-base font-semibold tracking-tight">
                {copy.availablePlans}
              </h2>
              <LanguageSelector />
            </div>
            <p className="text-xs text-muted-foreground">{copy.availablePlansNote}</p>
          </div>
        </header>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {publicPlans().map((plan) => {
            const active = plan.id === settings.plan;
            const text = planCopy(plan, locale);
            const reference = localizedReferencePrice(plan, locale);
            const savings = localizedSavings(plan, locale);
            return (
              <div
                key={plan.id}
                className={cn(
                  "flex flex-col rounded-2xl border p-5",
                  active ? "border-primary bg-primary/10" : "border-border bg-surface",
                )}
              >
                <p className="font-display text-lg font-bold">{plan.baseName}</p>
                <p className="text-xs text-muted-foreground">{text.subtitle}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {localizedPlanPrice(plan, locale)}
                </p>
                {reference ? (
                  <p className="text-xs text-muted-foreground line-through">{reference}</p>
                ) : null}
                {savings ? (
                  <p className="mt-1 text-xs font-semibold text-primary">{savings}</p>
                ) : null}
                <ul className="mt-4 flex-1 space-y-2 text-sm">
                  {text.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span className="text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-5"
                  variant={active ? "outline" : "default"}
                  disabled={active || choose.isPending || plan.cta === "talk_to_team"}
                  onClick={() => choose.mutate(plan.id)}
                >
                  {active
                    ? copy.selectedPlan
                    : plan.cta === "talk_to_team" || checkoutAvailable
                      ? text.ctaLabel
                      : copy.requestActivation}
                </Button>

              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
