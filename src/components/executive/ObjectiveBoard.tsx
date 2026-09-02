import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ClipboardList } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  OBJECTIVE_STATUS_TONE,
  objectiveTargetLabel,
  type ExecutiveObjective,
} from "@/lib/executive/objectives.core";
import {
  closeExecutiveObjective,
  listExecutiveObjectives,
} from "@/lib/executive/objectives.functions";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

/** Calm, executive-level board. Real persisted objectives only — no progress fiction. */
export function ObjectiveBoard() {
  const queryClient = useQueryClient();
  const list = useServerFn(listExecutiveObjectives);
  const close = useServerFn(closeExecutiveObjective);

  const query = useQuery({
    queryKey: ["executive-objectives"],
    queryFn: () => list() as Promise<ExecutiveObjective[]>,
  });

  const closeMutation = useMutation({
    mutationFn: (vars: { id: string; status: "completed" | "closed" }) => close({ data: vars }),
    onSuccess: () => {
      toast.success("Objective updated");
      void queryClient.invalidateQueries({ queryKey: ["executive-objectives"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const objectives = query.data ?? [];

  return (
    <section aria-labelledby="objective-board-heading" className="panel p-5">
      <div className="flex items-center gap-2">
        <ClipboardList aria-hidden="true" className="size-4 text-primary" />
        <h2
          id="objective-board-heading"
          className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
        >
          Business objectives
        </h2>
      </div>

      {query.isLoading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : query.isError ? (
        <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Objectives could not be loaded.
        </p>
      ) : objectives.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border/70 p-5 text-center text-sm text-muted-foreground">
          No objective yet. Set one above.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {objectives.map((o) => (
            <li key={o.id} className="rounded-xl border border-border/60 bg-surface/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-sm font-medium leading-snug">{o.objective_text}</p>
                <Badge
                  className={cn(
                    "shrink-0 border bg-transparent text-[10px] uppercase tracking-[0.16em]",
                    OBJECTIVE_STATUS_TONE[o.status],
                  )}
                >
                  {o.status}
                </Badge>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="Target" value={objectiveTargetLabel(o)} />
                <Field label="Deadline" value={o.deadline ?? "Not specified"} />
                <Field label="Segment" value={o.target_segment ?? "Not specified"} />
              </div>

              {o.status === "active" ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={closeMutation.isPending}
                    onClick={() => closeMutation.mutate({ id: o.id, status: "completed" })}
                  >
                    Mark completed
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={closeMutation.isPending}
                    onClick={() => closeMutation.mutate({ id: o.id, status: "closed" })}
                  >
                    Close
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
