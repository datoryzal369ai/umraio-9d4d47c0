import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Scale } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { decideIslamicReview, listIslamicReviews } from "@/lib/islamic/review.functions";
import { cn } from "@/lib/utils";

type ReviewRow = {
  id: string;
  conversation_id: string | null;
  question: string;
  topic: string;
  risk_level: string | null;
  escalation_reason: string | null;
  ai_draft_answer: string | null;
  ai_sources: string | null;
  status: string;
  reviewer_id: string | null;
  approved_answer: string | null;
  rejection_reason: string | null;
  amendment_notes: string | null;
  delivery_status: string;
  reference: string | null;
  created_at: string;
  decided_at: string | null;
};

const RISK_TONE: Record<string, string> = {
  HIGH_RISK: "border-destructive/40 text-destructive",
  SENSITIVE: "border-amber-500/40 text-amber-400",
};

const STATUS_TONE: Record<string, string> = {
  PENDING: "border-amber-500/40 text-amber-400",
  AMENDED: "border-primary/40 text-primary",
  APPROVED: "border-emerald-500/40 text-emerald-400",
  REJECTED: "border-destructive/40 text-destructive",
};

function ReviewCard({
  review,
  canDecide,
  onDecide,
  pending,
}: {
  review: ReviewRow;
  canDecide: boolean;
  pending: boolean;
  onDecide: (args: {
    reviewId: string;
    decision: "approve" | "amend" | "reject";
    approvedAnswer?: string;
    amendmentNotes?: string;
    rejectionReason?: string;
  }) => void;
}) {
  const [answer, setAnswer] = useState(review.approved_answer ?? review.ai_draft_answer ?? "");
  const [reason, setReason] = useState("");
  const open = review.status === "PENDING" || review.status === "AMENDED";

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn(STATUS_TONE[review.status] ?? "")}>
          {review.status}
        </Badge>
        <Badge variant="outline" className={RISK_TONE[review.risk_level ?? ""] ?? ""}>
          {review.risk_level === "SENSITIVE"
            ? "SENSITIVE · CASE-SPECIFIC"
            : "HIGH-RISK · FATWA / CASE-SPECIFIC"}
        </Badge>
        <Badge variant="outline">{review.topic.replace("_", " ")}</Badge>
        {review.reference ? (
          <span className="font-mono text-xs text-muted-foreground">{review.reference}</span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {new Date(review.created_at).toLocaleString()}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium text-foreground">{review.question}</p>
      {review.escalation_reason ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Reason for escalation: {review.escalation_reason.replace(/_/g, " ")}
        </p>
      ) : null}
      {review.ai_draft_answer ? (
        <div className="mt-2 rounded-md border border-dashed border-primary/40 bg-primary/5 p-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
            AI-generated draft — human review required
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
            {review.ai_draft_answer}
          </p>
          {review.ai_sources ? (
            <p className="mt-1 text-xs text-muted-foreground">Sources: {review.ai_sources}</p>
          ) : null}
        </div>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        Conversation: {review.conversation_id ? review.conversation_id.slice(0, 8) : "—"} · Approver:{" "}
        {review.reviewer_id ? review.reviewer_id.slice(0, 8) : "unassigned"} · Delivery:{" "}
        {review.delivery_status}
      </p>

      {review.status === "REJECTED" && review.rejection_reason ? (
        <p className="mt-2 text-sm text-muted-foreground">Reason: {review.rejection_reason}</p>
      ) : null}
      {review.status === "APPROVED" && review.approved_answer ? (
        <p className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-sm text-foreground">
          {review.approved_answer}
        </p>
      ) : null}

      {open && canDecide ? (
        <div className="mt-3 space-y-2">
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={
              review.status === "AMENDED"
                ? "Confirm the amended answer before it is sent to the customer…"
                : "Verified answer to send to the customer…"
            }
            rows={3}
          />
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Rejection reason (required to reject)…"
            rows={2}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                onDecide({ reviewId: review.id, decision: "approve", approvedAnswer: answer })
              }
            >
              Approve &amp; send
            </Button>
            {review.status === "PENDING" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  onDecide({ reviewId: review.id, decision: "amend", amendmentNotes: answer })
                }
              >
                Amend
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                onDecide({ reviewId: review.id, decision: "reject", rejectionReason: reason })
              }
            >
              Reject
            </Button>
          </div>
        </div>
      ) : open ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Only an owner, admin or Islamic approver can decide this review.
        </p>
      ) : null}
    </li>
  );
}

export function IslamicReviewQueue() {
  const queryClient = useQueryClient();
  const fetchReviews = useServerFn(listIslamicReviews);
  const decide = useServerFn(decideIslamicReview);
  const query = useQuery({ queryKey: ["islamic-review-queue"], queryFn: () => fetchReviews() });

  const mutation = useMutation({
    mutationFn: (args: {
      reviewId: string;
      decision: "approve" | "amend" | "reject";
      approvedAnswer?: string;
      amendmentNotes?: string;
      rejectionReason?: string;
    }) => decide({ data: args }),
    onSuccess: (result) => {
      toast.success(
        result.status === "APPROVED"
          ? result.delivered
            ? "Approved and sent to the customer."
            : "Approved. Delivery could not be completed."
          : result.status === "AMENDED"
            ? "Amended answer saved — confirm it to send."
            : "Review rejected.",
      );
      void queryClient.invalidateQueries({ queryKey: ["islamic-review-queue"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reviews = (query.data?.reviews ?? []) as ReviewRow[];
  const canDecide = query.data?.canDecide ?? false;
  const groups: Array<[string, ReviewRow[]]> = [
    ["PENDING", reviews.filter((r) => r.status === "PENDING")],
    ["AMENDED", reviews.filter((r) => r.status === "AMENDED")],
    ["APPROVED", reviews.filter((r) => r.status === "APPROVED")],
    ["REJECTED", reviews.filter((r) => r.status === "REJECTED")],
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <header className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 rounded-lg border border-border p-2 text-primary">
          <Scale className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">
            Islamic Implementation Layer™ — Expert Review Queue
          </h2>
          <p className="text-sm text-muted-foreground">
            AI handles established Islamic knowledge automatically. High-risk, complex or
            fatwa-level questions are escalated here for qualified human experts, who approve, amend
            or reject the AI-generated draft. Approved answers are sent to the customer exactly as
            written — the AI never regenerates them.
          </p>
        </div>
      </header>

      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !reviews.length ? (
        <p className="text-sm text-muted-foreground">
          No escalations. Basic and ordinary Islamic questions are answered automatically and never
          enter this queue.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map(([status, rows]) =>
            rows.length ? (
              <div key={status}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {status} ({rows.length})
                </h3>
                <ul className="space-y-3">
                  {rows.map((r) => (
                    <ReviewCard
                      key={r.id}
                      review={r}
                      canDecide={canDecide}
                      pending={mutation.isPending}
                      onDecide={(args) => mutation.mutate(args)}
                    />
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      )}
    </section>
  );
}
