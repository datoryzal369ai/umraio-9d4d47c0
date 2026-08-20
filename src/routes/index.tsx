import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, PlayCircle, Sparkles } from "lucide-react";

import wordmarkAsset from "@/assets/umraio-wordmark-clear.png.asset.json";

import { BrandArchitecture } from "@/components/brand/BrandArchitecture";
import { AutomationShowcase } from "@/components/marketing/AutomationShowcase";
import { PricingSection } from "@/components/marketing/PricingSection";
import { WorkforceMetrics } from "@/components/marketing/WorkforceMetrics";
import { IntelligenceArchitecture } from "@/components/marketing/IntelligenceArchitecture";
import {
  BuiltForUmrah,
  ClosingStatement,
  CustomerTrust,
  DifferentiationLadder,
  GovernedAutonomy,
} from "@/components/marketing/PositioningSections";


import { BrandLogo } from "@/components/brand/BrandLogo";
import { LanguageSelector } from "@/components/app/LanguageSelector";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useLocale } from "@/lib/i18n/locale";
import { SCHEMA_FAQS, siteCopy } from "@/lib/i18n/site.i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "UMRAIO® — AI Autonomous Business Executive for Umrah Agencies" },
      {
        name: "description",
        content:
          "UMRAIO® is an AI Autonomous Business Executive for Umrah agencies — helping automate WhatsApp enquiries, qualify leads, recommend packages, follow up and grow sales.",
      },
      {
        property: "og:title",
        content: "UMRAIO® — AI Autonomous Business Executive for Umrah Agencies",
      },
      {
        property: "og:description",
        content:
          "UMRAIO® is an AI Autonomous Business Executive for Umrah agencies — helping automate WhatsApp enquiries, qualify leads, recommend packages, follow up and grow sales.",
      },
      { property: "og:url", content: "https://umraio.com/" },
      { property: "og:type", content: "website" },
      {
        name: "twitter:title",
        content: "UMRAIO® — AI Autonomous Business Executive for Umrah Agencies",
      },
      {
        name: "twitter:description",
        content:
          "AI Autonomous Business Executive for Umrah agencies — WhatsApp enquiry automation, lead qualification, package recommendations and automated follow-up.",
      },

      { property: "og:image", content: `https://umraio.com${wordmarkAsset.url}` },
      {
        property: "og:image:alt",
        content: "UMRAIO® — AI Autonomous Business Executive for Umrah agencies",
      },
      { property: "og:locale", content: "en_MY" },
      { property: "og:site_name", content: "UMRAIO®" },
      { name: "twitter:image", content: `https://umraio.com${wordmarkAsset.url}` },
      {
        name: "twitter:image:alt",
        content: "UMRAIO® — AI Autonomous Business Executive for Umrah agencies",
      },
      { name: "robots", content: "index, follow, max-image-preview:large" },
    ],
    links: [{ rel: "canonical", href: "https://umraio.com/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: SCHEMA_FAQS.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }),
      },
    ],
  }),
  component: Index,
});


function Index() {
  const { user, loading } = useAuth();
  const { locale } = useLocale();
  const t = siteCopy(locale);

  return (
    <div className="relative min-h-dvh overflow-hidden bg-aurora">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-particles opacity-70" />

      <div className="relative">
        <header className="mx-auto grid w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-6 py-8 sm:px-10 sm:py-10">
          <BrandLogo showTagline />
          <nav className="flex items-center gap-2 sm:gap-3">
            <LanguageSelector />
            {loading ? null : user ? (
              <Button asChild size="sm" className="rounded-full">
                <Link to="/dashboard">{t.nav.dashboard}</Link>
              </Button>
            ) : (
              <>
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="hidden rounded-full sm:inline-flex"
                >
                  <Link to="/auth" search={{ mode: "login", redirect: undefined }}>
                    {t.nav.signIn}
                  </Link>
                </Button>
                <Button asChild size="sm" className="rounded-full shadow-elevated">
                  <Link to="/auth" search={{ mode: "register", redirect: undefined }}>
                    {t.hero.ctaTrial}
                  </Link>
                </Button>
              </>
            )}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-7xl px-6 pb-28 sm:px-10">
          <section className="flex flex-col items-center pt-14 text-center sm:pt-24">
            <span className="animate-rise inline-flex items-center gap-2 rounded-full border border-primary/30 bg-surface/60 px-4 py-1.5 text-[10px] font-light uppercase tracking-[0.28em] text-muted-foreground shadow-[0_0_24px_-12px_var(--color-primary)] backdrop-blur sm:text-[11px]">
              <Sparkles className="size-3.5 text-primary" />
              <span className="whitespace-nowrap">
                {t.hero.poweredBy}{" "}
                <span className="font-medium text-primary">
                  RÉNAIO.CORE
                  <sup className="ml-0.5 align-super text-[0.62em] leading-none tracking-normal">™</sup>
                </span>
              </span>
            </span>

            <div
              className="animate-rise relative mt-12 w-full max-w-3xl"
              style={{ animationDelay: "60ms" }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 blur-3xl"
                style={{
                  background:
                    "radial-gradient(50% 60% at 50% 50%, rgba(0,215,255,0.22), transparent 70%)",
                }}
              />
              <img
                src={wordmarkAsset.url}
                alt="UMRAIO® — AI Autonomous Business Executive"
                fetchPriority="high"
                decoding="async"
                className="mx-auto w-full max-w-2xl object-contain"
              />
            </div>
            <p
              className="animate-rise mt-4 text-[10px] font-light uppercase tracking-[0.42em] text-primary/90 sm:text-xs"
              style={{ animationDelay: "120ms" }}
            >
              {t.hero.kicker}
            </p>

            <h1
              className="animate-rise mt-12 max-w-4xl text-balance text-3xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl"
              style={{ animationDelay: "180ms" }}
            >
              {t.hero.headingLead}{" "}
              <span className="text-gradient-brand">{t.hero.headingAccent}</span>
            </h1>
            <p
              className="animate-rise mt-6 max-w-xl text-balance text-base font-light leading-relaxed text-muted-foreground sm:max-w-2xl sm:text-lg"
              style={{ animationDelay: "240ms" }}
            >
              {t.hero.subheading}
            </p>

            <div
              className="animate-rise mt-8 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row sm:gap-4"
              style={{ animationDelay: "300ms" }}
            >
              <Button
                asChild
                size="lg"
                className="btn-premium h-13 w-full rounded-2xl px-8 text-base font-semibold text-background hover:bg-transparent sm:w-auto"
              >
                <Link to="/auth" search={{ mode: "register", redirect: undefined }}>
                  {t.hero.ctaTrial}
                  <ArrowRight className="umr-arrow ml-1 size-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="ghost"
                className="btn-glass h-13 w-full rounded-2xl px-8 text-base font-medium sm:w-auto"
              >
                <Link to="/meet">
                  <Sparkles className="mr-1 size-4 text-primary" />
                  {t.hero.ctaMeet}
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="ghost"
                className="btn-glass h-13 w-full rounded-2xl px-8 text-base font-medium sm:w-auto"
              >
                <Link to="/meet" hash="book-demo">
                  <PlayCircle className="mr-1 size-4 text-primary" />
                  {t.hero.ctaDemo}
                </Link>
              </Button>
            </div>

            <WorkforceMetrics className="mt-10 sm:mt-12" />
          </section>

          <AutomationShowcase />

          <IntelligenceArchitecture />

          <BuiltForUmrah />
          <CustomerTrust />
          <GovernedAutonomy />
          <DifferentiationLadder />


          <PricingSection />

          <section className="mt-24" aria-labelledby="faq-heading">
            <h2
              id="faq-heading"
              className="text-center text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t.faqHeading}
            </h2>
            <div className="mx-auto mt-10 grid max-w-3xl gap-4">
              {t.faqs.map((item) => (
                <article key={item.q} className="panel p-6 text-left">
                  <h3 className="text-base font-semibold tracking-tight">{item.q}</h3>
                  <p className="mt-2.5 text-sm font-light leading-relaxed text-muted-foreground">
                    {item.a}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <ClosingStatement />
        </main>

        <BrandArchitecture />
      </div>
    </div>
  );
}
