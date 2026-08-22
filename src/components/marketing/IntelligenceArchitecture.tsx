import aiLogoAsset from "@/assets/ai-autonomous-intelligence-logo.png.asset.json";
import renaioMark from "@/assets/renaio-core-mark.png.asset.json";

import { useLocale } from "@/lib/i18n/locale";

/**
 * ONE architecture moment for the whole public experience.
 *
 * Locked hierarchy (top → bottom):
 * RÉNAIO.CORE™ → ĀI™ → Islamic Implementation Layer™ → UMRAIO® →
 * AI AUTONOMOUS BUSINESS EXECUTIVE™ → AI Workforce → Business Actions
 */

const COPY = {
  en: {
    eyebrow: "Intelligence architecture",
    heading: "From intelligence to execution.",
    lede: "One autonomous intelligence architecture for governed business execution.",
    coreLabel: "The Autonomous Intelligence Core",
    coreCaps: ["Context", "Memory", "Reasoning", "Orchestration", "Learning"],
    aiParadigm: "Autonomous Intelligence Paradigm",
    aiPlain: "AI = Artificial Intelligence",
    aiAutonomous: "ĀI™ = Autonomous Intelligence™",
    governanceRole: "Domain • Governance • Contextual rules",
    productRole: "The product for modern Umrah agencies",
    execSub: "Executive orchestration layer",
    workforce: "AI Workforce",
    workforceRole: "Specialist autonomous operators",
    actions: "Business Actions",
    actionsRole: "Measured, verifiable outcomes",
    pipeline: ["Detect", "Understand", "Decide", "Execute", "Verify", "Deliver", "Learn"],
  },
  bm: {
    eyebrow: "Seni bina kecerdasan",
    heading: "Daripada kecerdasan kepada pelaksanaan.",
    lede: "Satu seni bina kecerdasan autonomi untuk pelaksanaan perniagaan yang ditadbir.",
    coreLabel: "Teras Kecerdasan Autonomi",
    coreCaps: ["Konteks", "Memori", "Penaakulan", "Orkestrasi", "Pembelajaran"],
    aiParadigm: "Paradigma Kecerdasan Autonomi",
    aiPlain: "AI = Kecerdasan Buatan",
    aiAutonomous: "ĀI™ = Autonomous Intelligence™",
    governanceRole: "Domain • Tadbir urus • Peraturan konteks",
    productRole: "Produk untuk agensi Umrah moden",
    execSub: "Lapisan orkestrasi eksekutif",
    workforce: "AI Workforce",
    workforceRole: "Operator autonomi pakar",
    actions: "Business Actions",
    actionsRole: "Hasil yang boleh disahkan",
    pipeline: ["Kesan", "Faham", "Putus", "Laksana", "Sah", "Hantar", "Belajar"],
  },
} as const;

function Connector() {
  return (
    <span
      aria-hidden
      className="my-6 block h-10 w-px bg-gradient-to-b from-primary/50 via-primary/25 to-transparent sm:my-8 sm:h-12"
    />
  );
}

function LevelLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9px] font-medium uppercase tracking-[0.34em] text-muted-foreground/70">
      {children}
    </p>
  );
}

export function IntelligenceArchitecture() {
  const t = COPY[useLocale().locale];

  return (
    <section
      id="intelligence-architecture"
      className="mt-24 scroll-mt-24 sm:mt-28"
      aria-labelledby="intelligence-architecture-heading"
    >
      <div className="panel-exec relative overflow-hidden px-5 py-12 sm:px-12 sm:py-16">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div
            className="absolute inset-x-0 top-0 h-64"
            style={{
              background:
                "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--color-primary) 16%, transparent), transparent 72%)",
            }}
          />
        </div>

        <header className="mx-auto max-w-2xl text-center">
          <p className="text-[10px] font-medium uppercase tracking-[0.36em] text-primary/85">
            {t.eyebrow}
          </p>
          <h2
            id="intelligence-architecture-heading"
            className="mt-4 text-balance text-2xl font-extrabold leading-[1.15] tracking-tight sm:text-4xl"
          >
            {t.heading}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm font-light leading-[1.75] text-muted-foreground">
            {t.lede}
          </p>
        </header>

        <div className="mx-auto mt-10 flex w-full max-w-xl flex-col items-center text-center">
          {/* LEVEL 1 — RÉNAIO.CORE™ */}
          <div className="relative flex size-[200px] items-center justify-center sm:size-[280px]">
            <span
              aria-hidden
              className="umr-core-halo pointer-events-none absolute inset-0 -z-10 rounded-full blur-2xl"
              style={{
                background:
                  "radial-gradient(50% 50% at 50% 50%, rgba(42,212,230,0.38), transparent 72%)",
              }}
            />
            <img
              src={renaioMark.url}
              alt="RÉNAIO.CORE™"
              loading="eager"
              className="umr-core-mark h-full w-full object-contain mix-blend-screen"
            />
          </div>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.26em] text-primary">
            {t.coreLabel}
          </p>
          <ul className="mt-4 flex flex-wrap justify-center gap-2">
            {t.coreCaps.map((c) => (
              <li
                key={c}
                className="chip-capability rounded-full px-3 py-1 text-[9.5px] font-medium uppercase tracking-[0.18em]"
              >
                {c}
              </li>
            ))}
          </ul>

          <Connector />

          {/* LEVEL 2 — ĀI™ */}
          <div className="flex w-full flex-col items-center">
            <img
              src={aiLogoAsset.url}
              alt="ĀI™ — Autonomous Intelligence™"
              loading="lazy"
              className="h-auto w-[130px] object-contain py-2 sm:w-[160px] lg:w-[190px]"
            />
            <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">
              {t.aiParadigm}
            </p>
            <div className="mt-3 flex flex-col items-center gap-1 text-[11px] font-light text-muted-foreground">
              <span>{t.aiPlain}</span>
              <span className="font-medium text-foreground/85">{t.aiAutonomous}</span>
            </div>
          </div>


          <Connector />

          {/* LEVEL 5 — AI AUTONOMOUS BUSINESS EXECUTIVE™ */}
          <div className="w-full rounded-2xl border border-primary/70 bg-primary/[0.1] px-5 py-8 shadow-[0_0_70px_-30px_var(--color-primary)] backdrop-blur sm:px-8">
            <h3 className="text-balance font-display text-[26px] font-black uppercase leading-[1.05] tracking-tight text-foreground sm:text-[44px]">
              AI Autonomous
              <br />
              Business Executive
              <sup className="ml-0.5 align-super text-[0.32em] font-semibold tracking-normal text-primary">
                ™
              </sup>
            </h3>
            <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.26em] text-primary/90">
              {t.execSub}
            </p>
          </div>

          <Connector />

          {/* LEVEL 6 — AI WORKFORCE */}
          <div className="w-full rounded-2xl border border-border/60 bg-surface/50 px-5 py-4 backdrop-blur">
            <p className="text-sm font-semibold uppercase tracking-tight text-foreground/90">
              {t.workforce}
            </p>
            <div className="mt-1">
              <LevelLabel>{t.workforceRole}</LevelLabel>
            </div>
          </div>

          <Connector />

          {/* LEVEL 7 — BUSINESS ACTIONS */}
          <div className="w-full">
            <p className="text-sm font-semibold uppercase tracking-tight text-foreground/90">
              {t.actions}
            </p>
            <p className="mt-1 text-[10px] font-light uppercase tracking-[0.2em] text-muted-foreground/85">
              {t.actionsRole}
            </p>
            <ol className="mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
              {t.pipeline.map((step, i) => (
                <li key={step} className="flex items-center gap-2">
                  <span className="rounded-full border border-primary/35 bg-primary/[0.06] px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.18em] text-primary/95">
                    {step}
                  </span>
                  {i < t.pipeline.length - 1 ? (
                    <span aria-hidden className="text-primary/40">
                      →
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
