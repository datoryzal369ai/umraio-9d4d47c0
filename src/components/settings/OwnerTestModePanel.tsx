import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FlaskConical, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DEFAULT_TEST_OVERRIDE_HOURS,
  MAX_TEST_OVERRIDE_HOURS,
  MIN_REASON_LENGTH,
  TEST_MODE_NOTICE,
  TEST_OVERRIDE_CATEGORIES,
  describeOverride,
  type TestOverrideCategory,
} from "@/lib/testing/owner-test-mode.core";
import { getOwnerTestMode, setOwnerTestMode } from "@/lib/testing/owner-test-mode.functions";

const CATEGORY_LABELS: Record<TestOverrideCategory, string> = {
  ai_replies: "AI replies",
  ai_tasks: "AI worker tasks",
  voice_minutes: "Voice minutes",
};

/**
 * OWNER TEST MODE console — visible only to the agency owner.
 * Bypasses usage/allowance gates ONLY. Never billing, never safety.
 */
export function OwnerTestModePanel() {
  const queryClient = useQueryClient();
  const load = useServerFn(getOwnerTestMode);
  const save = useServerFn(setOwnerTestMode);

  const { data, isLoading } = useQuery({
    queryKey: ["owner-test-mode"],
    queryFn: () => load(),
  });

  const [selected, setSelected] = useState<TestOverrideCategory[]>([...TEST_OVERRIDE_CATEGORIES]);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(DEFAULT_TEST_OVERRIDE_HOURS);
  const [confirmed, setConfirmed] = useState(false);

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof setOwnerTestMode>[0] extends never ? never : any) =>
      save(input),
    onSuccess: () => {
      setConfirmed(false);
      void queryClient.invalidateQueries({ queryKey: ["owner-test-mode"] });
      void queryClient.invalidateQueries({ queryKey: ["usage-overview"] });
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not update Owner Test Mode."),
  });

  if (isLoading) return <Skeleton className="h-40 w-full rounded-2xl" />;
  if (!data?.canManage) return null;

  const status = describeOverride(data.state);

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-display text-base font-bold">Owner Test Mode — quota override</h2>
        </div>
        <Badge variant={status.on ? "destructive" : "secondary"} className="text-[10px]">
          {status.label}
        </Badge>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Temporary internal testing switch for this agency only. It bypasses usage allowance gates
        for AI replies, AI worker tasks and voice minutes. It does not change your usage counters,
        plan, subscription, invoices or commercial limits, and it never bypasses Islamic
        Implementation Layer™ safety, review approvals, WhatsApp security, authentication or
        payment verification.
      </p>

      {status.on ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 text-destructive" />
          <div className="text-xs">
            <p className="font-semibold text-destructive">{TEST_MODE_NOTICE}</p>
            <p className="mt-1 text-muted-foreground">
              Categories: {data.state.categories.map((c) => CATEGORY_LABELS[c]).join(", ")}
              {data.state.expiresAt
                ? ` · auto-expires ${new Date(data.state.expiresAt).toLocaleString()}`
                : null}
            </p>
            {data.state.reason ? (
              <p className="mt-1 text-muted-foreground">Reason: {data.state.reason}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {status.on ? (
        <Button
          className="mt-4"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ enabled: false })}
        >
          Turn Test Mode OFF
        </Button>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-4">
            {TEST_OVERRIDE_CATEGORIES.map((category) => (
              <label key={category} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={selected.includes(category)}
                  onCheckedChange={(value) =>
                    setSelected((prev) =>
                      value === true
                        ? [...new Set([...prev, category])]
                        : prev.filter((c) => c !== category),
                    )
                  }
                />
                {CATEGORY_LABELS[category]}
              </label>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <div>
              <Label className="text-xs">Reason (required, stored in the audit log)</Label>
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={`At least ${MIN_REASON_LENGTH} characters, e.g. "E2E voice V2.1 test"`}
              />
            </div>
            <div>
              <Label className="text-xs">Hours (max {MAX_TEST_OVERRIDE_HOURS})</Label>
              <Input
                type="number"
                min={1}
                max={MAX_TEST_OVERRIDE_HOURS}
                value={hours}
                onChange={(event) => setHours(Number(event.target.value))}
              />
            </div>
          </div>

          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
            />
            <span>
              I confirm this is an internal test override. Usage counters and billing stay
              unchanged and normal enforcement returns when it is turned off or expires.
            </span>
          </label>

          <Button
            disabled={!confirmed || mutation.isPending || selected.length === 0}
            onClick={() =>
              mutation.mutate({
                enabled: true,
                confirm: true,
                reason,
                categories: selected,
                hours,
              })
            }
          >
            Enable Owner Test Mode
          </Button>
        </div>
      )}

      {data.audit.length > 0 ? (
        <div className="mt-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Audit trail</p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {data.audit.slice(0, 8).map((event) => (
              <li key={event.id}>
                <span className="font-medium text-foreground">{event.action}</span>{" "}
                {new Date(event.created_at).toLocaleString()}
                {event.categories?.length ? ` · ${event.categories.join(", ")}` : ""}
                {event.reason ? ` · ${event.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
