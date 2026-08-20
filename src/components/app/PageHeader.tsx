import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Optional back navigation so no detail screen becomes a dead end. */
  backTo?: string;
  backLabel?: string;
};

/** Shared page header: eyebrow + h1 + description, with optional back link and actions. */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
  backTo,
  backLabel = "Back",
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4", className)}>
      {backTo ? (
        <Link
          to={backTo as never}
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {backLabel}
        </Link>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p>
          ) : null}
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

