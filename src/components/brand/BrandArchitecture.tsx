import umraioAsset from "@/assets/umraio-official-wordmark.png.asset.json";
import umraverseAsset from "@/assets/umraverse-logo.png.asset.json";
import renaioAsset from "@/assets/renaio-core-logo.png.asset.json";
import aiAsset from "@/assets/ai-autonomous-intelligence.png.asset.json";
import { useLocale } from "@/lib/i18n/locale";
import { siteCopy } from "@/lib/i18n/site.i18n";
import { cn } from "@/lib/utils";

function Connector() {
  return (
    <span
      aria-hidden
      className="my-10 block h-14 w-px bg-gradient-to-b from-transparent via-primary/40 to-transparent sm:my-14 sm:h-20"
    />
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-light uppercase tracking-[0.42em] text-muted-foreground/70">
      {children}
    </p>
  );
}

/** Single source of truth for the UMRAIO brand architecture + corporate attribution. */
export function BrandArchitecture({ className }: { className?: string }) {
  const t = siteCopy(useLocale().locale).footer;

  return (
    <footer
      className={cn("border-t border-border/50 px-6 py-20 sm:px-10 sm:py-28", className)}
      aria-label="Brand architecture"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
        {/* PRIMARY — UMRAIO */}
        <img
          src={umraioAsset.url}
          alt="UMRAIO® — AI Autonomous Business Executive"
          loading="lazy"
          className="h-auto w-full max-w-[260px] object-contain mix-blend-screen sm:max-w-[340px]"
        />
        <p className="mt-3 text-[10px] font-light uppercase leading-[1.6] tracking-[0.3em] text-muted-foreground sm:text-[11px]">
          {t.tagline}
        </p>

        <Connector />

        {/* SECONDARY — RÉNAIO.CORE */}
        <Label>{t.poweredBy}</Label>
        <img
          src={renaioAsset.url}
          alt="RÉNAIO.CORE™ — The Autonomous Intelligence Core"
          loading="lazy"
          className="mt-6 h-auto w-full max-w-[280px] object-contain mix-blend-screen sm:max-w-[400px]"
        />

        <Connector />

        {/* TECHNOLOGY IDENTITY — ĀI™ AUTONOMOUS INTELLIGENCE */}
        <Label>Built on</Label>
        <img
          src={aiAsset.url}
          alt="ĀI™ — Autonomous Intelligence"
          loading="lazy"
          className="mt-6 h-auto w-full max-w-[420px] object-contain mix-blend-screen sm:max-w-[560px]"
        />
        <p className="mt-3 max-w-md text-[11px] font-light leading-relaxed text-muted-foreground/70">
          AI provides intelligent capabilities. ĀI™ is our paradigm for turning those capabilities
          into autonomous systems.
        </p>

        <Connector />

        {/* GOVERNANCE — ISLAMIC IMPLEMENTATION LAYER */}
        <Label>{t.governedBy}</Label>
        <p className="mt-3 text-sm font-semibold tracking-tight text-foreground/85">
          Islamic Implementation Layer™
        </p>
        <p className="mt-1.5 text-[10px] font-light uppercase tracking-[0.28em] text-muted-foreground/70">
          {t.governancePillars}
        </p>

        <Connector />

        {/* TERTIARY — UMRAVERSE */}
        <Label>{t.partOf}</Label>
        <img
          src={umraverseAsset.url}
          alt="UMRAVERSE® — Your Umrah Universe"
          loading="lazy"
          className="mt-6 h-auto w-full max-w-[200px] object-contain mix-blend-screen sm:max-w-[260px]"
        />

        <Connector />

        {/* CORPORATE OWNER */}
        <Label>{t.ownedBy}</Label>
        <p className="mt-3 text-sm font-medium tracking-tight text-foreground/80">
          Digital Renaissance Metaverse
        </p>

        <div className="mt-14 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground/80">
          <a
            href="/privacy-policy"
            className="transition-colors hover:text-primary hover:underline hover:underline-offset-4"
          >
            {t.privacy}
          </a>
          <a
            href="/terms"
            className="transition-colors hover:text-primary hover:underline hover:underline-offset-4"
          >
            {t.terms}
          </a>
          <a
            href="/data-deletion"
            className="transition-colors hover:text-primary hover:underline hover:underline-offset-4"
          >
            {t.dataDeletion}
          </a>
        </div>

        <p className="mt-8 text-xs font-light text-muted-foreground/60">
          © {new Date().getFullYear()} UMRAIO®. {t.rights}
        </p>
      </div>
    </footer>
  );
}
