import renaioMark from "@/assets/renaio-core-mark.png.asset.json";
import { useLocale } from "@/lib/i18n/locale";
import { cn } from "@/lib/utils";

/**
 * ONE architecture moment for the whole public experience.
 *
 * Single governed flow: RÉNAIO.CORE™ → ĀI™ → ISLAMIC IMPLEMENTATION LAYER™ →
 * UMRAIO® → AI AUTONOMOUS BUSINESS EXECUTIVE™ → AI WORKFORCE → BUSINESS ACTIONS.
 * Compact tiers, subtle vertical connectors, one turquoise-cyan accent family.
 */

const COPY = {
  en: {
    eyebrow: "Intelligence architecture",
    heading: "From intelligence to execution.",
    lede: "One autonomous intelligence architecture for governed business execution.",
    coreLabel: "The Autonomous Intelligence Core",
    coreCaps: ["Context", "Memory", "Reasoning", "Orchestration", "Learning"],
    aiParadigm: "Autonomous Intelligence",
    aiParadigmSub: "Paradigm",
    aiDistinction: ["AI = Artificial Intelligence", "ĀI™ = Autonomous Intelligence™"],
    tiers: [
      { name: "ISLAMIC IMPLEMENTATION LAYER™", role: "Domain • Governance • Contextual rules" },
      { name: "UMRAIO®", role: "The product for modern Umrah agencies" },
      {
        name: "AI AUTONOMOUS BUSINESS EXECUTIVE™",
        role: "Executive orchestration layer",
        hero: true,
      },
      { name: "AI WORKFORCE", role: "Specialist autonomous operators" },
      { name: "BUSINESS ACTIONS", role: "Measured, verifiable outcomes" },
    ],
    pipeline: ["Detect", "Understand", "Decide", "Execute", "Verify", "Deliver", "Learn"],
  },
  bm: {
    eyebrow: "Seni bina kecerdasan",
    heading: "Daripada kecerdasan kepada pelaksanaan.",
    lede: "Satu seni bina kecerdasan autonomi untuk pelaksanaan perniagaan yang ditadbir.",
    coreLabel: "Teras Kecerdasan Autonomi",
    coreCaps: ["Konteks", "Memori", "Penaakulan", "Orkestrasi", "Pembelajaran"],
    aiParadigm: "Kecerdasan Autonomi",
    aiParadigmSub: "Paradigma",
    aiDistinction: ["AI = Artificial Intelligence", "ĀI™ = Autonomous Intelligence™"],
    tiers: [
      { name: "ISLAMIC IMPLEMENTATION LAYER™", role: "Domain • Tadbir urus • Peraturan konteks" },
      { name: "UMRAIO®", role: "Produk untuk agensi Umrah moden" },
      {
        name: "AI AUTONOMOUS BUSINESS EXECUTIVE™",
        role: "Lapisan orkestrasi eksekutif",
        hero: true,
      },
      { name: "AI WORKFORCE", role: "Operator autonomi pakar" },
      { name: "BUSINESS ACTIONS", role: "Hasil yang boleh disahkan" },
    ],
    pipeline: ["Kesan", "Faham", "Putus", "Laksana", "Sah", "Hantar", "Belajar"],
  },
} as const;

function Connector() {
  return (
    <span
      aria-hidden
      className="mx-auto block h-6 w-px bg-gradient-to-b from-primary/55 to-primary/10 sm:h-7"
    />
  );
}

export function IntelligenceArchitecture() {
  const t = COPY[useLocale().locale];

  return (
    <section
      id="intelligence-architecture"
      className="mt-20 scroll-mt-24 sm:mt-24"
      aria-labelledby="intelligence-architecture-heading"
    >
      <div className="panel-exec relative overflow-hidden px-5 py-10 sm:px-12 sm:py-14">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div
            className="absolute inset-x-0 top-0 h-56"
            style={{
              background:
                "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--color-primary) 16%, transparent), transparent 72%)",
            }}
          />
        </div>

        <header className="mx-auto max-w-xl text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-primary">
            {t.eyebrow}
          </p>
          <h2
            id="intelligence-architecture-heading"
            className="mt-3 text-balance text-[26px] font-extrabold leading-[1.12] tracking-tight sm:text-4xl"
          >
            {t.heading}
          </h2>
          <p className="text-exec-support mx-auto mt-3 max-w-md text-sm leading-relaxed sm:text-base">
            {t.lede}
          </p>
        </header>

        <div className="mx-auto mt-10 w-full max-w-xl">
          {/* LEVEL 1 — RÉNAIO.CORE™ */}
          <div className="flex flex-col items-center">
            <div className="relative flex size-[150px] items-center justify-center sm:size-[210px]">
              <span
                aria-hidden
                className="umr-core-halo pointer-events-none absolute inset-0 -z-10 rounded-full blur-2xl"
                style={{
                  background:
                    "radial-gradient(50% 50% at 50% 50%, rgba(42,212,230,0.34), transparent 72%)",
                }}
              />
              <img
                src={renaioMark.url}
                alt="RÉNAIO.CORE™"
                loading="lazy"
                className="umr-core-mark h-full w-full object-contain mix-blend-screen"
              />
            </div>
            <p className="mt-3 text-center text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">
              {t.coreLabel}
            </p>
            <ul className="mt-3 flex flex-wrap justify-center gap-1.5">
              {t.coreCaps.map((c) => (
                <li
                  key={c}
                  className="chip-capability rounded-full px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.16em]"
                >
                  {c}
                </li>
              ))}
            </ul>
          </div>

          <Connector />

          {/* LEVEL 2 — ĀI™ */}
          <div className="rounded-2xl border border-primary/55 bg-primary/[0.08] px-5 py-6 text-center shadow-[0_0_60px_-34px_var(--color-primary)]">
            <div className="relative mx-auto w-fit">
              <p className="text-exec-intelligence relative font-display text-[44px] font-extrabold leading-none tracking-tight sm:text-6xl">
                ĀI
                <sup className="ml-0.5 align-super text-[0.32em] font-bold leading-none tracking-normal">
                  ™
                </sup>
              </p>
            </div>
            <p className="mt-3 text-[12px] font-bold uppercase tracking-[0.2em] text-primary sm:text-sm">
              {t.aiParadigm}
            </p>
            <p className="text-exec-support mt-1 text-[10px] font-medium uppercase tracking-[0.24em] opacity-80">
              {t.aiParadigmSub}
            </p>
            <p className="mt-4 text-[10px] font-medium leading-[1.9] tracking-[0.06em] text-muted-foreground sm:text-[11px]">
              {t.aiDistinction[0]}
              <br />
              {t.aiDistinction[1]}
            </p>
          </div>

          {/* LEVELS 3–7 */}
          <ol className="w-full">
            {t.tiers.map((node) => (
              <li key={node.name} className="flex flex-col">
                <Connector />
                <div
                  className={cn(
                    "rounded-2xl border px-4 py-3.5 text-center backdrop-blur sm:px-5",
                    "hero" in node && node.hero
                      ? "border-primary/55 bg-primary/[0.07] shadow-[0_0_60px_-36px_var(--color-primary)]"
                      : "border-border/60 bg-surface/50",
                  )}
                >
                  <p
                    className={cn(
                      "text-balance tracking-tight",
                      "hero" in node && node.hero
                        ? "text-exec-intelligence text-[15px] font-extrabold uppercase leading-[1.2] sm:text-xl"
                        : "text-[13px] font-bold text-foreground sm:text-[15px]",
                    )}
                  >
                    {node.name}
                  </p>
                  <p className="text-exec-support mt-1 text-[10px] font-medium uppercase tracking-[0.18em] opacity-75 sm:text-[11px]">
                    {node.role}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          {/* Execution pipeline */}
          <ol className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
            {t.pipeline.map((step, i) => (
              <li key={step} className="flex items-center gap-2">
                <span className="rounded-full border border-primary/35 bg-primary/[0.07] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-primary">
                  {step}
                </span>
                {i < t.pipeline.length - 1 ? (
                  <span aria-hidden className="text-primary/45">
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
