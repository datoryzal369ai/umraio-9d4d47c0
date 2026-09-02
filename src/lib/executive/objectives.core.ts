/**
 * UMRAIO® — COMMANDER PHASE 1 · business objective domain (pure).
 *
 * Phase 1 is deliberately COMMAND → PERSIST → DISPLAY. Nothing in this module
 * plans, queues, approves or executes anything. Structured fields are only
 * ever captured from an explicit human confirmation — never inferred into an
 * action.
 */

export const OBJECTIVE_STATUSES = ["active", "completed", "closed"] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export type ExecutiveObjective = {
  id: string;
  agency_id: string;
  created_by: string | null;
  objective_text: string;
  parsed_metric: string | null;
  target_quantity: number | null;
  deadline: string | null;
  target_segment: string | null;
  status: ObjectiveStatus;
  created_at: string;
  updated_at: string;
};

export type ObjectiveInput = {
  objectiveText: string;
  metric?: string | null;
  quantity?: number | null;
  deadline?: string | null;
  segment?: string | null;
};

export type ValidatedObjective = {
  objective_text: string;
  parsed_metric: string | null;
  target_quantity: number | null;
  deadline: string | null;
  target_segment: string | null;
};

const MAX_TEXT = 1000;
const MAX_FIELD = 120;

const trimmed = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  return s.length ? s : null;
};

/** Validate and normalise a human-entered objective. Throws on invalid input. */
export function validateObjectiveInput(input: ObjectiveInput): ValidatedObjective {
  const text = trimmed(input?.objectiveText, MAX_TEXT);
  if (!text) throw new Error("Objective is required");

  let quantity: number | null = null;
  if (input?.quantity !== undefined && input.quantity !== null && `${input.quantity}` !== "") {
    const n = Number(input.quantity);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Target quantity must be a positive number");
    quantity = n;
  }

  let deadline: string | null = null;
  const rawDeadline = trimmed(input?.deadline, 40);
  if (rawDeadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDeadline) || Number.isNaN(Date.parse(rawDeadline)))
      throw new Error("Deadline must be a valid date");
    deadline = rawDeadline;
  }

  return {
    objective_text: text,
    parsed_metric: trimmed(input?.metric, MAX_FIELD),
    target_quantity: quantity,
    deadline,
    target_segment: trimmed(input?.segment, MAX_FIELD),
  };
}

/** Human-readable target line. Never fabricates a target that was not given. */
export function objectiveTargetLabel(o: ExecutiveObjective): string {
  if (o.target_quantity === null && !o.parsed_metric) return "Not specified";
  const qty = o.target_quantity === null ? "" : `${o.target_quantity} `;
  return `${qty}${o.parsed_metric ?? ""}`.trim();
}

export const OBJECTIVE_STATUS_TONE: Record<ObjectiveStatus, string> = {
  active: "border-primary/50 bg-primary/10 text-primary",
  completed: "border-success/40 bg-success/10 text-success",
  closed: "border-border/60 bg-surface/60 text-muted-foreground",
};

export function isObjectiveStatus(value: unknown): value is ObjectiveStatus {
  return typeof value === "string" && (OBJECTIVE_STATUSES as readonly string[]).includes(value);
}
