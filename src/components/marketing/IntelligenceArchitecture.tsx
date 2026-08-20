import aiMark from "@/assets/ai-mark.png.asset.json";
import renaioAsset from "@/assets/renaio-core-logo.png.asset.json";
import { useLocale } from "@/lib/i18n/locale";

/**
 * ONE architecture moment for the whole public experience.
 *
 * Replaces the previously repeated Islamic layer / intelligence loop /
 * ecosystem stack sections so the architecture is explained exactly once,
 * with the official ĀI™ mark integrated as ambient intelligence lighting
 * rather than a poster pasted into a card.
 */

const COPY = {
  en: {
    eyebrow: "Intelligence architecture",
    heading: "From intelligence to execution.",
    lede: "One foundation. One governance layer. One executive. A full autonomous workforce.",
    aiVsAi: [
      { k: "AI", v: "Intelligent capability" },
      { k: "ĀI™", v: "Autonomous intelligence paradigm" },
    ],
    coreLabel: "The Autonomous Intelligence Core",
    coreCaps: ["Context", "Memory", "Reasoning", "Orchestration", "Learning"],
    chain: [
      { name: "ISLAMIC IMPLEMENTATION LAYER™", role: "Domain, governance & contextual rules" },
      { name: "UMRAIO®", role: "The product for modern Umrah agencies" },
      { name: "AUTONOMOUS AI BUSINESS EXECUTIVE™", role: "Executive orchestration layer" },
      { name: "AI WORKFORCE", role: "Specialist autonomous operators" },
      { name: "BUSINESS ACTIONS", role: "Measured, verifiable outcomes" },
    ],
    pipeline: ["Detect", "Understand", "Decide", "Execute", "Verify", "Deliver", "Learn"],
  },
  bm: {
    eyebrow: "Seni bina kecerdasan",
    heading: "Daripada kecerdasan kepada pelaksanaan.",
    lede: "Satu asas. Satu lapisan tadbir urus. Satu eksekutif. Satu tenaga kerja autonomi penuh.",
    aiVsAi: [
      { k: "AI", v: "Keupayaan pintar" },
      { k: "ĀI™", v: "Paradigma kecerdasan autonomi" },
    ],
    coreLabel: "Teras Kecerdasan Autonomi",
    coreCaps: ["Konteks", "Memori", "Penaakulan", "Orkestrasi", "Pembelajaran"],
    chain: [
      { name: "ISLAMIC IMPLEMENTATION LAYER™", role: "Domain, tadbir urus & peraturan konteks" },
      { name: "UMRAIO®", role: "Produk untuk agensi Umrah moden" },
      { name: "AUTONOMOUS AI BUSINESS EXECUTIVE™", role: "Lapisan orkestrasi eksekutif" },
      { name: "AI WORKFORCE", role: "Operator autonomi pakar" },
      { name: "BUSINESS ACTIONS", role: "Hasil yang boleh disahkan" },
    ],
    pipeline: ["Kesan", "Faham", "Putus", "Laksana", "Sah", "Hantar", "Belajar"],
  },
} as const;

export function IntelligenceArchitecture() {
  const t = COPY[useLocale().locale];

  return (
    <section className="mt-24 sm:mt-28" aria-labelledby="intelligence-architecture-heading">
      <div className="panel-exec relative overflow-hidden px-6 py-12 sm:px-12 sm:py-16">
        {/* Integrated ĀI™ intelligence lighting — part of the surface, not a pasted poster. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div
            className="absolute inset-x-0 top-0 h-72"
            style={{
              background:
                "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--color-primary) 22%, transparent), transparent 72%)",
            }}
          />
          <img
            src={aiMark.url}
            alt=""
            loading="lazy"
            className="absolute left-1/2 top-2 w-[clamp(220px,42vw,460px)] -translate-x-1/2 object-contain opacity-[0.10] mix-blend-screen blur-[1px]"
          />
        </div>

        <header className="mx-auto max-w-2xl text-center">
          <p className="text-[10px] font-medium uppercase tracking-[0.36em] text-primary/80">
            {t.eyebrow}
          </p>

          <div className="relative mx-auto mt-8 w-full max-w-[300px]">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 blur-3xl"
              style={{
                background:
                  "radial-gradient(50% 60% at 50% 50%, rgba(0,215,255,0.28), transparent 70%)",
              }}
            />
            <img
              src={aiMark.url}
              alt="ĀI™ — Autonomous Intelligence"
              loading="lazy"
              className="mx-auto w-full object-contain mix-blend-screen drop-shadow-[0_18px_40px_rgba(0,0,0,0.55)]"
            />
          </div>

          <h2
            id="intelligence-architecture-heading"
            className="mt-8 text-balance text-2xl font-extrabold leading-[1.15] tracking-tight sm:text-4xl"
          >
            {t.heading}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm font-light leading-[1.8] text-muted-foreground">
            {t.lede}
          </p>
        </header>

        {/* AI vs ĀI™ — stated once, compactly. */}
        <div className="mx-auto mt-10 grid max-w-2xl gap-3 sm:grid-cols-2">
          {t.aiVsAi.map((row) => (
            <div
              key={row.k}
              className="rounded-2xl border border-border/60 bg-surface/60 px-5 py-4 text-center backdrop-blur"
            >
              <p className="text-lg font-semibold tracking-tight text-chrome">{row.k}</p>
              <p className="mt-1 text-[11px] font-light uppercase tracking-[0.18em] text-muted-foreground">
                {row.v}
              </p>
            </div>
          ))}
        </div>

        {/* RÉNAIO.CORE™ + chain, shown once. */}
        <div className="mx-auto mt-12 flex max-w-xl flex-col items-center">
          <img
            src={renaioAsset.url}
            alt="RÉNAIO.CORE™ — The Autonomous Intelligence Core"
            loading="lazy"
            className="h-auto w-full max-w-[260px] object-contain mix-blend-screen"
          />
          <p className="mt-2 text-[10px] font-light uppercase tracking-[0.3em] text-muted-foreground/80">
            {t.coreLabel}
          </p>
          <ul className="mt-4 flex flex-wrap justify-center gap-2">
            {t.coreCaps.map((c) => (
              <li
                key={c}
                className="rounded-full border border-border/70 bg-surface/50 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
              >
                {c}
              </li>
            ))}
          </ul>

          <ol className="mt-8 w-full">
            {t.chain.map((node, i) => (
              <li key={node.name} className="flex flex-col items-center">
                <span
                  aria-hidden
                  className="my-3 block h-7 w-px bg-gradient-to-b from-primary/50 to-transparent"
                />
                <div className="w-full rounded-2xl border border-border/60 bg-surface/50 px-5 py-3.5 text-center backdrop-blur">
                  <p className="text-[13px] font-semibold tracking-tight sm:text-sm">{node.name}</p>
                  <p className="mt-1 text-[10px] font-light uppercase tracking-[0.22em] text-muted-foreground/80">
                    {node.role}
                  </p>
                </div>
                {i === t.chain.length - 1 ? null : null}
              </li>
            ))}
          </ol>
        </div>

        {/* Execution pipeline — the operational read of the same architecture. */}
        <ol className="mt-12 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          {t.pipeline.map((step, i) => (
            <li key={step} className="flex items-center gap-3">
              <span className="rounded-full border border-primary/25 bg-primary/8 px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.22em] text-primary/90">
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
    </section>
  );
}
