import { CheckCircle2, GitCommit, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";

declare const __BUILD_COMMIT__: string;
declare const __HAS_OWNER_TEST_MODE__: boolean;

const commit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "unknown";
const hasOwnerTestMode =
  typeof __HAS_OWNER_TEST_MODE__ === "boolean" ? __HAS_OWNER_TEST_MODE__ : false;

const repoUrl = import.meta.env["VITE_REPO_URL"] as string | undefined;

/**
 * Shows whether the build currently being served includes the Owner Test Mode
 * console, plus the commit hash it was built from. Diagnostics only — it never
 * affects quotas, billing or entitlement.
 */
export function BuildInfoBanner() {
  const commitHref = repoUrl ? `${repoUrl.replace(/\/$/, "")}/commit/${commit}` : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 text-xs">
      <div className="flex items-center gap-2">
        {hasOwnerTestMode ? (
          <CheckCircle2 className="size-4 text-primary" />
        ) : (
          <TriangleAlert className="size-4 text-muted-foreground" />
        )}
        <span className="text-muted-foreground">
          {hasOwnerTestMode
            ? "This live build includes Owner Test Mode."
            : "This live build does not include Owner Test Mode."}
        </span>
        <Badge variant={hasOwnerTestMode ? "default" : "secondary"} className="text-[10px]">
          {hasOwnerTestMode ? "Included" : "Not in build"}
        </Badge>
      </div>

      <div className="flex items-center gap-1.5 text-muted-foreground">
        <GitCommit className="size-3.5" />
        <span>Deploy commit</span>
        {commitHref ? (
          <a
            href={commitHref}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-foreground underline underline-offset-2"
          >
            {commit}
          </a>
        ) : (
          <span className="font-mono text-foreground">{commit}</span>
        )}
      </div>
    </div>
  );
}
