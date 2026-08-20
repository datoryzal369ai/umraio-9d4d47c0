import aiMarkAsset from "@/assets/ai-autonomous-intelligence.png.asset.json";
import { useLocale } from "@/lib/i18n/locale";
import { cn } from "@/lib/utils";

type Copy = {
  eyebrow: string;
  heading: string;
  lede: string;
  roles: Record<string, string>;
  vs: { ai: string; aiDesc: string; aai: string; aaiDesc: string; flow: string };
  note: string;
};

const COPY: Record<"en" | "bm", Copy> = {
  en: {
    eyebrow: "Architecture",
    heading: "Intelligence into execution",
    lede: "How autonomous intelligence becomes real business execution inside UMRAIO®.",
    roles: {
      renaio: "Autonomous Intelligence Core",
      ai: "Autonomous Intelligence™",
      islamic: "Domain & context implementation",
      umraio: "Product — the autonomous AI workforce",
      exec: "AI Executive / Orchestrator",
      workforce: "Specialist business execution",
      actions: "Real-world execution & outcomes",
    },
    vs: {
      ai: "Artificial Intelligence",
      aiDesc: "Intelligent capability",
      aai: "Autonomous Intelligence™",
      aaiDesc: "Autonomous intelligence paradigm",
      flow: "Understand → Reason → Decide → Act → Learn → Adapt",
    },
    note: "A conceptual architecture. Only capabilities marked live are in production today.",
  },
  bm: {
    eyebrow: "Seni bina",
    heading: "Kecerdasan menjadi pelaksanaan",
    lede: "Bagaimana kecerdasan autonomi menjadi pelaksanaan perniagaan sebenar dalam UMRAIO®.",
    roles: {
      renaio: "Teras Kecerdasan Autonomi",
      ai: "Autonomous Intelligence™",
      islamic: "Pelaksanaan domain & konteks",
      umraio: "Produk — tenaga kerja AI autonomi",
      exec: "AI Eksekutif / Orkestrator",
      workforce: "Pelaksanaan perniagaan pakar",
      actions: "Pelaksanaan & hasil sebenar",
    },
    vs: {
      ai: "Artificial Intelligence",
      aiDesc: "Keupayaan pintar",
      aai: "Autonomous Intelligence™",
      aaiDesc: "Paradigma kecerdasan autonomi",
      flow: "Faham → Menaakul → Putus → Bertindak → Belajar → Adaptasi",
    },
    note: "Seni bina konseptual. Hanya keupayaan bertanda live berada dalam produksi hari ini.",
  },
};

function Arrow() {
  return (
    <span
      aria-hidden
      className="mx-auto block h-8 w-px bg-gradient-to-b from-transparent via-chrome/40 to-transparent sm:h-10"
    />
  );
}

function Tier({
  title,
  role,
  tone = "default",
  children,
}: {
  title: string;
  role: string;
  tone?: "default" | "exec" | "gold";
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-xl rounded-2xl border border-border/70 bg-card/70 px-5 py-5 text-center backdrop-blur",
        tone === "default" && "card-interactive",
        tone === "exec" && "panel-exec",
        tone === "gold" && "panel-elite card-interactive-gold",
      )}
    >
      <p
        className={cn(
          "text-sm font-semibold tracking-tight sm:text-base",
          tone === "exec" && "text-chrome",
          tone === "gold" && "text-champagne",
        )}
      >
        {title}
      </p>
      <p className="mt-1.5 text-[10px] font-light uppercase tracking-[0.26em] text-muted-foreground">
        {role}
      </p>
      {children}
    </div>
  );
}

/** Locked UMRAIO® conceptual architecture: RÉNAIO.CORE™ → ĀI™ → Islamic Implementation Layer™ → UMRAIO® → Executive → Workforce → Actions. */
export function IntelligenceArchitecture() {
  const { locale } = useLocale();
  const t = COPY[locale === "bm" ? "bm" : "en"];

  return (
    <section className="mt-24" aria-labelledby="architecture-heading">
      <div className="text-center">
        <p className="text-[10px] font-light uppercase tracking-[0.36em] text-muted-foreground">
          {t.eyebrow}
        </p>
        <h2 id="architecture-heading" className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          {t.heading}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm font-light leading-relaxed text-muted-foreground">
          {t.lede}
        </p>
      </div>

      <div className="mt-12 flex flex-col items-center">
        <Tier title="RÉNAIO.CORE™" role={t.roles.renaio} />
        <Arrow />

        <div className="mx-auto w-full max-w-xl rounded-2xl panel-exec px-5 py-6 text-center">
          <img
            src={aiMarkAsset.url}
            alt="ĀI™ — Autonomous Intelligence™"
            loading="lazy"
            className="mx-auto h-auto w-full max-w-[220px] object-contain sm:max-w-[280px]"
          />
          <p className="mt-4 text-[10px] font-light uppercase tracking-[0.26em] text-muted-foreground">
            {t.roles.ai}
          </p>

          <div className="mt-6 grid gap-3 text-left sm:grid-cols-2">
            <div className="rounded-xl border border-border/70 bg-background/40 p-4">
              <p className="text-xs font-semibold tracking-tight">AI</p>
              <p className="mt-1 text-[11px] font-light text-muted-foreground">{t.vs.ai}</p>
              <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/80">
                {t.vs.aiDesc}
              </p>
            </div>
            <div className="rounded-xl border border-border/70 bg-background/40 p-4">
              <p className="text-xs font-semibold tracking-tight text-chrome">ĀI™</p>
              <p className="mt-1 text-[11px] font-light text-muted-foreground">{t.vs.aai}</p>
              <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/80">
                {t.vs.aaiDesc}
              </p>
            </div>
          </div>
          <p className="mt-4 text-[10px] font-light uppercase tracking-[0.22em] text-muted-foreground/80">
            {t.vs.flow}
          </p>
        </div>

        <Arrow />
        <Tier title="ISLAMIC IMPLEMENTATION LAYER™" role={t.roles.islamic} />
        <Arrow />
        <Tier title="UMRAIO®" role={t.roles.umraio} />
        <Arrow />
        <Tier title="AI AUTONOMOUS BUSINESS EXECUTIVE™" role={t.roles.exec} tone="exec" />
        <Arrow />
        <Tier title="AI WORKFORCE" role={t.roles.workforce}>
          <p className="mt-3 text-[11px] font-light leading-relaxed text-muted-foreground">
            AI SALES ELITE™ · AI MARKETING EXECUTIVE™ · AI CUSTOMER EXPERIENCE EXECUTIVE™ · AI
            OPERATIONS EXECUTIVE™ · AI BUSINESS INTELLIGENCE™
          </p>
        </Tier>
        <Arrow />
        <Tier title="BUSINESS ACTIONS" role={t.roles.actions} />
      </div>

      <p className="mt-10 text-center text-[11px] font-light text-muted-foreground/70">{t.note}</p>
    </section>
  );
}
