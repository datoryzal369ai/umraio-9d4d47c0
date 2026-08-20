import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import raioAsset from "@/assets/raio-executive.png.asset.json";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { LanguageSelector } from "@/components/app/LanguageSelector";
import { MeetExecutive } from "@/components/marketing/MeetExecutive";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/i18n/locale";
import { siteCopy } from "@/lib/i18n/site.i18n";

export const Route = createFileRoute("/meet")({
  head: () => ({
    meta: [
      { title: "Meet Your Autonomous AI Business Executive™ | UMRAIO®" },
      {
        name: "description",
        content:
          "Tell RAIŌ how your Umrah agency works. UMRAIO's Autonomous AI Business Executive™ will identify where automation can improve your sales workflow — before you subscribe.",
      },
      { property: "og:title", content: "Meet Your Autonomous AI Business Executive™ | UMRAIO®" },
      {
        property: "og:description",
        content:
          "Meet RAIŌ — UMRAIO's Autonomous AI Business Executive™ for Umrah agencies. A guided business diagnosis, not a generic chatbot.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://umraio.com/meet" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Meet Your Autonomous AI Business Executive™ | UMRAIO®" },
      {
        name: "twitter:description",
        content:
          "A guided business demonstration with RAIŌ — UMRAIO's Autonomous AI Business Executive™ for Umrah agencies.",
      },
      { name: "robots", content: "index, follow" },
    ],
    links: [{ rel: "canonical", href: "https://umraio.com/meet" }],
  }),

  component: MeetPage,
});

function MeetPage() {
  const { locale } = useLocale();
  const t = siteCopy(locale).meet;
  const tNav = siteCopy(locale).nav.back;

  return (
    <div className="relative min-h-dvh overflow-hidden bg-aurora">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid" />

      <div className="relative">
        <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-6 sm:px-10 sm:py-8">
          <BrandLogo />
          <div className="flex items-center gap-2">
            <LanguageSelector />
            <Button asChild variant="ghost" className="h-11 rounded-full px-4">
              <Link to="/">
                <ArrowLeft className="mr-1 size-4" aria-hidden />
                {tNav}
              </Link>
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl px-5 pb-20 sm:px-10">
          <section className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-10">
            <div className="text-center lg:col-start-1 lg:row-start-1 lg:text-left">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-primary">
                {t.eyebrow}
              </p>
              <h1 className="mt-3 text-balance text-3xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
                {t.headingLine1}
                <br />
                <span className="text-gradient-brand">{t.headingAccent}</span>
                <sup className="ml-0.5 align-super text-[0.4em] leading-none">™</sup>
              </h1>
            </div>

            <div className="flex flex-col items-center lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
              <img
                src={raioAsset.url}
                alt="RAIŌ — UMRAIO's Autonomous AI Business Executive™"
                className="w-full max-w-[260px] object-contain drop-shadow-[0_24px_60px_hsl(var(--primary)/0.25)] sm:max-w-[340px]"
                width={1159}
                height={1332}
              />
              <p className="mt-2 font-display text-lg font-bold tracking-[0.2em]">RAIŌ</p>
              <p className="text-center text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {t.roleLine}
              </p>
            </div>

            <div className="text-center lg:col-start-1 lg:row-start-2 lg:text-left">
              <p className="text-balance text-base font-light text-muted-foreground sm:text-lg">
                {t.lede}
              </p>
              <p className="mt-4 text-balance text-sm font-light leading-relaxed text-muted-foreground">
                {t.body}
              </p>
            </div>
          </section>


          <div className="mt-10">
            <MeetExecutive />
          </div>
        </main>

      </div>
    </div>
  );
}
