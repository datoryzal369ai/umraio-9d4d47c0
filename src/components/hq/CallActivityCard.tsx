import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Link2,
  MemoryStick,
  PhoneCall,
  Unlink,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { HqCallObservability, HqChannelActivityItem, HqLatencySummary } from "@/lib/hq/hq.core";
import { cn } from "@/lib/utils";

type LiveCallItem = HqChannelActivityItem & { callObservability: HqCallObservability };

const formatDate = (iso: string | null) => {
  if (!iso) return "Unavailable";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
};

const formatDuration = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
};

const formatLatency = (milliseconds: number) =>
  milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1)}s` : `${milliseconds}ms`;

function StatusBadge({ status }: { status: HqChannelActivityItem["interactionStatus"] }) {
  return (
    <Badge
      variant={status === "SUCCESS" ? "default" : status === "FAILED" ? "destructive" : "secondary"}
      className="shrink-0 gap-1.5"
    >
      {status === "FAILED" ? <AlertTriangle aria-hidden="true" className="size-3" /> : <Circle aria-hidden="true" className="size-2 fill-current" />}
      {status}
    </Badge>
  );
}

function EvidenceBadge({
  label,
  state,
  icon: Icon,
}: {
  label: string;
  state: "PRESENT" | "ABSENT" | "UNKNOWN" | "LINKED" | "NOT LINKED";
  icon: typeof Link2;
}) {
  const positive = state === "PRESENT" || state === "LINKED";
  const unknown = state === "UNKNOWN";
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/35 px-2.5 py-2">
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", positive ? "text-primary" : "text-muted-foreground")} />
      <div className="min-w-0">
        <p className="truncate text-[10px] uppercase text-muted-foreground">{label}</p>
        <p className={cn("truncate text-xs font-semibold", unknown ? "text-muted-foreground" : "text-foreground")}>{state}</p>
      </div>
    </div>
  );
}

function Journey({ call }: { call: HqCallObservability }) {
  const stages = [
    ["Received", call.receivedAt],
    ["Meta Accepted", call.metaAcceptedAt],
    ["Media Ready", call.mediaReadyAt],
    ["Answered", call.answeredAt],
    ["Ended", call.endedAt],
  ] as const;

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">Call journey</h4>
      <ol className="mt-3 grid gap-0 sm:grid-cols-5">
        {stages.map(([label, value], index) => {
          const complete = Boolean(value);
          return (
            <li key={label} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 pb-3 sm:block sm:pb-0">
              {index < stages.length - 1 && (
                <span aria-hidden="true" className={cn("absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px sm:left-6 sm:top-3 sm:h-px sm:w-[calc(100%-1.5rem)]", complete && stages[index + 1]?.[1] ? "bg-primary/70" : "bg-border")} />
              )}
              <span className={cn("relative z-10 grid size-6 place-items-center rounded-full border", complete ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-muted-foreground")}>
                {complete ? <Check aria-hidden="true" className="size-3.5" /> : <Circle aria-hidden="true" className="size-2.5" />}
              </span>
              <div className="min-w-0 sm:mt-2 sm:pr-2">
                <p className={cn("text-xs font-semibold", complete ? "text-foreground" : "text-muted-foreground")}>{label}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{complete ? formatDate(value) : "Unavailable"}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function LatencyMetric({ label, value }: { label: string; value: HqLatencySummary | null }) {
  const valid = value && Number.isFinite(value.p50) && Number.isFinite(value.p95) && value.p50 >= 0 && value.p95 >= 0;
  return (
    <div className={cn("rounded-md border p-3", label === "Total" ? "border-primary/45 bg-primary/5" : "border-border/70 bg-background/35")}>
      <p className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</p>
      {valid ? (
        <>
          <p className="mt-1 text-lg font-semibold text-foreground">{formatLatency(value.p50)}</p>
          <p className="text-[10px] text-muted-foreground">P95 {formatLatency(value.p95)} · {value.samples} samples</p>
        </>
      ) : value === null ? (
        <p className="mt-2 text-xs font-semibold text-muted-foreground">NO DATA</p>
      ) : (
        <p className="mt-2 text-xs font-semibold text-muted-foreground">UNKNOWN</p>
      )}
    </div>
  );
}

export function CallActivityCard({ item }: { item: LiveCallItem }) {
  const [open, setOpen] = useState(false);
  const call = item.callObservability;
  const outcome = call.voiceOutcome?.trim() || "UNKNOWN";
  const language = call.detectedLanguage?.trim() || "UNKNOWN";
  const closing = call.closingState?.trim() || "UNKNOWN";

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
      <div className="p-4 sm:p-5">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/30 bg-primary/10 text-primary">
              <PhoneCall aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase text-primary">Live call</p>
              <h3 className="truncate text-base font-semibold">{item.contactName}</h3>
              <p className="truncate font-mono text-xs text-muted-foreground">{item.contactPhone}</p>
            </div>
          </div>
          <StatusBadge status={item.interactionStatus} />
        </header>

        <div className="mt-4 grid gap-x-4 gap-y-3 border-y border-border/70 py-3 text-sm sm:grid-cols-4">
          <div className="min-w-0 sm:col-span-2">
            <p className="text-[10px] uppercase text-muted-foreground">Agency</p>
            <p className="truncate font-medium">{item.agencyName}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Duration</p>
            <p className="font-medium">{formatDuration(call.durationSeconds)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Turns</p>
            <p className="font-medium">{call.turnCount}</p>
          </div>
          <div className="min-w-0 sm:col-span-4">
            <p className="text-[10px] uppercase text-muted-foreground">Time</p>
            <p className="truncate text-xs text-muted-foreground">{formatDate(item.occurredAt)}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <EvidenceBadge label="Customer" state={call.leadLinked ? "LINKED" : "NOT LINKED"} icon={call.leadLinked ? Link2 : Unlink} />
          <EvidenceBadge label="Conversation" state={call.conversationLinked ? "LINKED" : "NOT LINKED"} icon={call.conversationLinked ? Link2 : Unlink} />
          <EvidenceBadge label="Memory" state={call.memoryContinuity} icon={MemoryStick} />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant="outline">Outcome · {outcome}</Badge>
          <Badge variant="outline">Language · {language}</Badge>
          <Badge variant="outline">Closing · {closing}</Badge>
        </div>
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="h-11 w-full justify-between rounded-none border-t border-border/70 px-4 text-xs sm:px-5">
            Operational Details
            <ChevronDown aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-6 border-t border-border/70 bg-background/25 p-4 sm:p-5">
            <Journey call={call} />

            {item.interactionStatus === "FAILED" && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div><p className="font-semibold text-foreground">Call did not complete</p><p className="mt-0.5 text-muted-foreground">{call.terminationReason ?? "Failure reason unavailable"}</p></div>
              </div>
            )}

            <section>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">Call performance</h4>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <LatencyMetric label="ASR" value={call.latency.asr} />
                <LatencyMetric label="Context" value={call.latency.context} />
                <LatencyMetric label="Reasoning" value={call.latency.reasoning} />
                <LatencyMetric label="TTS" value={call.latency.tts} />
                <LatencyMetric label="Total" value={call.latency.total} />
              </div>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground">Conversation</h4>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">Outcome</dt><dd className="mt-0.5 font-medium">{outcome}</dd></div>
                  <div><dt className="text-muted-foreground">Language</dt><dd className="mt-0.5 font-medium">{language}</dd></div>
                  <div><dt className="text-muted-foreground">Closing</dt><dd className="mt-0.5 font-medium">{closing}</dd></div>
                  <div><dt className="text-muted-foreground">Termination</dt><dd className="mt-0.5 font-medium">{call.terminationReason ?? "UNKNOWN"}</dd></div>
                </dl>
              </div>
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground">Technical evidence</h4>
                <dl className="mt-2 space-y-2 text-xs">
                  <div><dt className="text-muted-foreground">Source state</dt><dd className="font-medium">{call.sourceStatus}</dd></div>
                  <div><dt className="text-muted-foreground">Record ID</dt><dd className="truncate font-mono text-[10px] text-muted-foreground" title={call.recordId}>{call.recordId}</dd></div>
                </dl>
              </div>
            </section>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}
