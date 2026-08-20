import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchWorkers } from "@/lib/executive";
import { sortWorkforce } from "@/lib/executive/worker-state";
import { EXECUTIVE_CENTER_DICT } from "@/lib/i18n/app/executive-center.i18n";
import { useCopy } from "@/lib/i18n/dict";
import { cn } from "@/lib/utils";

/** Workers with a dedicated workspace route instead of the generic worker page. */
const WORKER_ROUTES: Record<string, "/sales-elite"> = { sales_elite: "/sales-elite" };

/** Type-safe link to any worker, respecting dedicated workspace routes. */
export function WorkerLink({
  workerKey,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  workerKey: string;
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  const dedicated = WORKER_ROUTES[workerKey];
  if (dedicated) {
    return (
      <Link to={dedicated} className={className} aria-label={ariaLabel}>
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/executive/$workerKey"
      params={{ workerKey }}
      className={className}
      aria-label={ariaLabel}
    >
      {children}
    </Link>
  );
}

/**
 * Worker-local navigation: breadcrumb trail back to the AI Executive Center plus
 * previous / next movement across the Specialist AI Workforce, so no worker
 * screen is ever a dead end.
 */
export function WorkforceNavigator({
  workerKey,
  currentName,
  className,
}: {
  workerKey: string;
  currentName?: string;
  className?: string;
}) {
  const copy = useCopy(EXECUTIVE_CENTER_DICT);
  const workers = useQuery({ queryKey: ["ai-workers"], queryFn: fetchWorkers });

  const ordered = sortWorkforce(workers.data ?? []);
  const index = ordered.findIndex((w) => w.worker_key === workerKey);
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
  const name = currentName ?? (index >= 0 ? ordered[index]!.name : workerKey);

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <li>
            <Link
              to="/executive"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-primary"
            >
              <Home className="size-3.5" aria-hidden="true" />
              {copy.breadcrumbCenter}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link to="/executive/workforce" className="transition-colors hover:text-primary">
              {copy.breadcrumbWorkforce}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="truncate font-medium text-foreground">{name}</li>
        </ol>
      </nav>

      <div
        className="flex items-center gap-2"
        role="group"
        aria-label={copy.workforceNavigator}
      >
        {prev ? (
          <Button asChild size="sm" variant="outline">
            <WorkerLink workerKey={prev.worker_key} aria-label={`${copy.previousWorker}: ${prev.name}`}>
              <ChevronLeft className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{prev.name}</span>
              <span className="sm:hidden">{copy.previousWorker}</span>
            </WorkerLink>
          </Button>
        ) : null}
        {next ? (
          <Button asChild size="sm" variant="outline">
            <WorkerLink workerKey={next.worker_key} aria-label={`${copy.nextWorker}: ${next.name}`}>
              <span className="hidden sm:inline">{next.name}</span>
              <span className="sm:hidden">{copy.nextWorker}</span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </WorkerLink>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
