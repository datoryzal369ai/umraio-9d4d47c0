import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Target } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createExecutiveObjective } from "@/lib/executive/objectives.functions";

/**
 * COMMANDER PHASE 1 — objective capture only.
 * Creating an objective persists it. It does NOT plan, queue or execute
 * anything: structured fields stay human-confirmed.
 */
export function ObjectiveCommandBar() {
  const queryClient = useQueryClient();
  const create = useServerFn(createExecutiveObjective);

  const [objectiveText, setObjectiveText] = useState("");
  const [metric, setMetric] = useState("");
  const [quantity, setQuantity] = useState("");
  const [deadline, setDeadline] = useState("");
  const [segment, setSegment] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      create({
        data: {
          objectiveText,
          metric: metric || null,
          quantity: quantity ? Number(quantity) : null,
          deadline: deadline || null,
          segment: segment || null,
        },
      }),
    onSuccess: () => {
      toast.success("Objective recorded");
      setObjectiveText("");
      setMetric("");
      setQuantity("");
      setDeadline("");
      setSegment("");
      void queryClient.invalidateQueries({ queryKey: ["executive-objectives"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <section aria-labelledby="objective-command-heading" className="panel p-5">
      <div className="flex items-center gap-2">
        <Target aria-hidden="true" className="size-4 text-primary" />
        <h2
          id="objective-command-heading"
          className="font-display text-base font-extrabold tracking-tight"
        >
          What do you want to achieve?
        </h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Give your Executive a business objective.
      </p>

      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!objectiveText.trim()) {
            toast.error("Objective is required");
            return;
          }
          mutation.mutate();
        }}
      >
        <Textarea
          aria-label="Objective"
          value={objectiveText}
          onChange={(e) => setObjectiveText(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="I want 30 Umrah bookings for Ramadan 2027 within 30 days from families in Johor."
        />

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Input
            aria-label="Metric"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            placeholder="Metric (e.g. bookings)"
          />
          <Input
            aria-label="Target quantity"
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Quantity"
          />
          <Input
            aria-label="Deadline"
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
          <Input
            aria-label="Segment"
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            placeholder="Segment (e.g. families in Johor)"
          />
        </div>

        <p className="text-[11px] text-muted-foreground">
          Structured fields are optional and stay exactly as you confirm them. Nothing is executed
          from an objective at this stage.
        </p>

        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Recording…" : "Set objective"}
        </Button>
      </form>
    </section>
  );
}
