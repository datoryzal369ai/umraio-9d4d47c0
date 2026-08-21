import { BrainCircuit, BotMessageSquare, Clock3, TrendingUp, Zap } from "lucide-react";

import { useLocale } from "@/lib/i18n/locale";
import { siteCopy } from "@/lib/i18n/site.i18n";
import { cn } from "@/lib/utils";

/** Canonical figures — never translated. */
const METRIC_VALUES = ["24/7", "INSTANT", "AUTO", "ĀI™"] as const;
const METRIC_ICONS = [Clock3, TrendingUp, Zap, BrainCircuit];

function MetricModule({
  value,
  label,
  micro,
  icon: Icon,
  index,
}: {
  value: string;
  label: string;
  micro: string;
  icon: React.ElementType;
  index: number;
}) {
  return (
    <div
      className={cn(
        "umr-reveal group relative flex min-w-0 flex-col rounded-2xl text-left border border-border/60 bg-surface/40 p-4 transition-colors duration-300 hover:border-primary/35 sm:p-6",
      )}
      style={{ animationDelay: `${index * 90}ms` }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="umr-metric-ring grid size-9 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/10 sm:size-11">
          <Icon className="size-4 text-primary sm:size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p
            className={cn(
              "font-extrabold leading-none tracking-tight text-primary",
              value.length > 4 ? "text-base sm:text-2xl" : "text-2xl sm:text-4xl",
            )}
          >
            {value}
          </p>
          <p className="mt-1.5 text-[9px] font-medium uppercase tracking-[0.2em] text-foreground/80 sm:text-[11px]">
            {label}
          </p>
        </div>
      </div>
      <p className="mt-3 text-[11px] font-light leading-relaxed text-muted-foreground sm:text-xs">
        {micro}
      </p>
    </div>
  );
}

/** Premium AI workforce intelligence panel: four performance signals around one AI core. */
export function WorkforceMetrics({ className }: { className?: string }) {
  const t = siteCopy(useLocale().locale).metrics;

  return (
    <section
      aria-label={t.sectionLabel}
      className={cn("umr-reveal panel relative w-full overflow-hidden p-5 sm:p-8", className)}
      style={{ animationDelay: "360ms" }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(60% 55% at 50% 50%, rgba(0,215,255,0.10), transparent 72%)",
        }}
      />

      <div className="relative flex items-center justify-center gap-3">
        <span aria-hidden className="h-px w-8 bg-gradient-to-r from-transparent to-primary/40" />
        <p className="text-[9px] font-medium uppercase tracking-[0.32em] text-primary/85 sm:text-[10px]">
          UMRAIO<sup className="align-super text-[0.6em] leading-none">®</sup> AI Workforce
        </p>
        <span aria-hidden className="h-px w-8 bg-gradient-to-l from-transparent to-primary/40" />
      </div>

      <div className="relative mt-6 grid grid-cols-2 gap-3 sm:gap-5 lg:gap-6">
        {/* signal lines toward the core (desktop/tablet only) */}
        <span
          aria-hidden
          className="umr-signal-line pointer-events-none absolute left-1/2 top-1/2 hidden h-px w-[26%] -translate-x-full -translate-y-1/2 sm:block"
        />
        <span
          aria-hidden
          className="umr-signal-line pointer-events-none absolute left-1/2 top-1/2 hidden h-px w-[26%] -translate-y-1/2 sm:block"
        />

        {t.items.map((item, i) => (
          <MetricModule
            key={item.label}
            value={METRIC_VALUES[i]!}
            label={item.label}
            micro={item.micro}
            icon={METRIC_ICONS[i]!}
            index={i}
          />
        ))}

        {/* central AI intelligence hub */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <span className="umr-hub grid size-11 place-items-center rounded-full border border-primary/40 bg-background/90 shadow-[0_0_28px_-6px_var(--color-primary)] sm:size-16">
            <BotMessageSquare className="size-5 text-primary sm:size-7" />
          </span>
        </span>
      </div>
    </section>
  );
}
