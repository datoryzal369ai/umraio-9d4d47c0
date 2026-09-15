/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BadgeCheck, CalendarDays, Plane, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getPublicQuotation, respondPublicQuotation } from "@/lib/quotations.functions";
import { startQuotationPaymentFn } from "@/lib/payments.functions";
import {
  QUOTATION_STATUS_LABELS,
  formatMyrAmount,
  type QuotationStatus,
} from "@/lib/quotations/pricing.core";
import { useCopy } from "@/lib/i18n/dict";
import { accountCopy } from "@/lib/i18n/app/account.i18n";

export const Route = createFileRoute("/q/$token")({
  head: () => ({
    meta: [
      { title: "Your Umrah quotation — UMRAIO" },
      {
        name: "description",
        content:
          "Review your personalised Umrah package quotation: package details, price per pilgrim, total and deposit to secure your seats.",
      },
      { property: "og:title", content: "Your Umrah quotation" },
      {
        property: "og:description",
        content: "Package details, total price and the deposit required to secure your seats.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  errorComponent: ({ error }) => (
    <div role="alert" className="mx-auto max-w-xl p-10 text-sm text-destructive">
      {error.message}
    </div>
  ),
  notFoundComponent: () => {
    const copy = useCopy(accountCopy).quotation;
    return (
      <div className="mx-auto max-w-xl p-10 text-sm">{copy.linkNoLongerValid}</div>
    );
  },
  component: PublicQuotationPage,
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border/40 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function PublicQuotationPage() {
  const { token } = Route.useParams();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  // Informational only: Stripe's browser return can never confirm a payment.
  const paymentReturn =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("payment");
  const copy = useCopy(accountCopy).quotation;

  const { data, isLoading } = useQuery({
    queryKey: ["public-quotation", token],
    queryFn: () => getPublicQuotation({ data: { token } }),
  });

  /**
   * Commercial payment. The browser sends only the KIND; the server derives the
   * amount and creates the Stripe-hosted Checkout. Returning to this page never
   * marks anything paid — only the verified Stripe webhook does.
   */
  const pay = useMutation({
    mutationFn: (kind: "deposit" | "full") =>
      startQuotationPaymentFn({ data: { token, kind } }),
    onSuccess: (result: { url: string }) => {
      toast.success(copy.paymentStarting);
      window.location.href = result.url;
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const respond = useMutation({
    mutationFn: (decision: "accepted" | "rejected") =>
      respondPublicQuotation({ data: { token, decision, reason: reason.trim() || null } }),
    onSuccess: () => {
      toast.success(copy.thankYouToast);
      queryClient.invalidateQueries({ queryKey: ["public-quotation", token] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-xl p-10 text-sm text-muted-foreground">{copy.loading}</div>
    );
  }
  if (!data?.quotation) {
    return (
      <main className="mx-auto max-w-xl p-10">
        <h1 className="text-xl font-semibold">{copy.notFoundTitle}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{copy.notFoundBody}</p>
      </main>
    );
  }

  const q = data.quotation as Record<string, any>;
  const snap = (q["package_snapshot"] ?? {}) as Record<string, any>;
  const status = q["status"] as QuotationStatus;
  const open = ["ready", "sent", "viewed", "discussing"].includes(status);
  const payable =
    ["accepted", "deposit_pending"].includes(status) && Number(q["total"]) > 0;
  const depositAmount =
    q["deposit_due"] !== null && Number(q["deposit_due"]) > 0 ? Number(q["deposit_due"]) : null;
  const paymentNotice =
    paymentReturn === "processing"
      ? copy.paymentProcessing
      : paymentReturn === "cancelled"
        ? copy.paymentCancelled
        : null;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-primary">
          {data.agency?.name ?? copy.defaultAgency}
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          {copy.yourQuotation.replace("{number}", String(q["quotation_number"]))}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {copy.status}: {QUOTATION_STATUS_LABELS[status] ?? status}
          {q["valid_until"]
            ? copy.validUntil.replace(
                "{date}",
                new Date(q["valid_until"]).toLocaleDateString("en-MY"),
              )
            : ""}
        </p>
      </header>

      <section className="panel space-y-1 p-6">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Plane className="h-4 w-4 text-primary" aria-hidden /> {snap["name"] ?? copy.defaultPackage}
        </h2>
        {snap["hotel_makkah"] ? (
          <Row label={copy.makkahHotel} value={String(snap["hotel_makkah"])} />
        ) : null}
        {snap["hotel_madinah"] ? (
          <Row label={copy.madinahHotel} value={String(snap["hotel_madinah"])} />
        ) : null}
        {snap["nights"] ? <Row label={copy.nights} value={`${snap["nights"]}`} /> : null}
        {snap["airline"] ? <Row label={copy.airline} value={String(snap["airline"])} /> : null}
        {q["travel_month"] || q["travel_date"] ? (
          <Row label={copy.travel} value={String(q["travel_date"] ?? q["travel_month"])} />
        ) : null}
      </section>

      <section className="panel mt-6 space-y-1 p-6">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <BadgeCheck className="h-4 w-4 text-primary" aria-hidden /> {copy.priceBreakdown}
        </h2>
        <Row
          label={copy.pricePerPilgrim.replace("{quantity}", String(q["quantity"]))}
          value={formatMyrAmount(Number(q["unit_price"]))}
        />
        <Row label={copy.subtotal} value={formatMyrAmount(Number(q["subtotal"]))} />
        {Number(q["discount"]) > 0 ? (
          <Row label={copy.discount} value={`- ${formatMyrAmount(Number(q["discount"]))}`} />
        ) : null}
        <Row label={copy.total} value={formatMyrAmount(Number(q["total"]))} />
        {q["deposit_amount"] !== null ? (
          <>
            <Row label={copy.depositToSecure} value={formatMyrAmount(Number(q["deposit_amount"]))} />
            <Row label={copy.balance} value={formatMyrAmount(Number(q["balance_amount"]))} />
          </>
        ) : null}
        {Array.isArray(snap["inclusions"]) && snap["inclusions"].length ? (
          <p className="pt-3 text-sm text-muted-foreground">
            {copy.includes.replace("{items}", snap["inclusions"].join(", "))}
          </p>
        ) : null}
      </section>

      {payable ? (
        <section className="panel mt-6 space-y-4 p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> {copy.securePayment}
          </h2>
          <p className="text-sm text-muted-foreground">{copy.paymentDescription}</p>
          {paymentNotice ? (
            <p className="text-sm font-medium text-primary">{paymentNotice}</p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {depositAmount ? (
              <Button disabled={pay.isPending} onClick={() => pay.mutate("deposit")}>
                {copy.payDeposit.replace("{amount}", formatMyrAmount(depositAmount))}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={pay.isPending}
              onClick={() => pay.mutate("full")}
            >
              {copy.payInFull.replace("{amount}", formatMyrAmount(Number(q["total"])))}
            </Button>
          </div>
        </section>
      ) : null}

      {open ? (
        <section className="panel mt-6 space-y-4 p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> {copy.yourDecision}
          </h2>
          <p className="text-sm text-muted-foreground">{copy.decisionDescription}</p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 400))}
            placeholder={copy.messagePlaceholder}
            aria-label={copy.messageAriaLabel}
          />
          <div className="flex flex-wrap gap-3">
            <Button disabled={respond.isPending} onClick={() => respond.mutate("accepted")}>
              {copy.acceptQuotation}
            </Button>
            <Button
              variant="outline"
              disabled={respond.isPending}
              onClick={() => respond.mutate("rejected")}
            >
              {copy.notNow}
            </Button>
          </div>
        </section>
      ) : (
        <section className="panel mt-6 p-6 text-sm text-muted-foreground">
          <CalendarDays className="mb-2 h-4 w-4 text-primary" aria-hidden />
          {copy.closedNotice.replace(
            "{status}",
            QUOTATION_STATUS_LABELS[status]?.toLowerCase() ?? status,
          )}
        </section>
      )}
    </main>
  );
}
