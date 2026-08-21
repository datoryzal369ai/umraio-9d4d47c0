import {
  LOOP_STATE_LABEL,
  LOOP_STATE_TONE,
  deriveActionLoop,
  loopGlyph,
  type LoopStageView,
} from "@/lib/executive/loop.core";
import type { EngineTask } from "@/lib/tasks";
import type { OutcomeFinding } from "@/lib/executive/outcome.core";
import { cn } from "@/lib/utils";

/**
 * Per-action EXECUTIVE LOOP tracker. Every stage state comes from the real
 * backend lifecycle — a stage is never green because the action merely exists.
 */
export function ExecutiveLoopTracker({
  task,
  finding,
}: {
  task: EngineTask;
  finding?: OutcomeFinding | null;
}) {
  const stages: LoopStageView[] = deriveActionLoop(task, finding ?? null);

  return (
    <ol className="space-y-1.5" aria-label="Executive loop for this action">
      {stages.map((stage) => (
        <li
          key={stage.stage}
          className={cn(
            "flex min-w-0 items-start gap-2.5 rounded-lg border px-2.5 py-2",
            LOOP_STATE_TONE[stage.state],
          )}
        >
          <span aria-hidden="true" className="mt-px w-3 shrink-0 text-center text-xs font-bold">
            {loopGlyph(stage.state)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.14em]">
                {stage.label}
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-[0.12em] opacity-70">
                {LOOP_STATE_LABEL[stage.state]}
              </span>
            </div>
            {stage.note ? (
              <p className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground">
                {stage.note}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
