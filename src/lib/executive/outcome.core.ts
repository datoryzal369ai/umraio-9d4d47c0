/**
 * UMRAIO® — business-outcome vocabulary shared by server monitoring and UI.
 *
 * ACTION COMPLETED ≠ BUSINESS SUCCESS. The outcome classes below describe what
 * actually happened in the business after an executive action executed.
 */

export type OutcomeClass = "progressed" | "responded" | "no_response" | "unknown";

export type OutcomeFinding = {
  taskId: string;
  leadId: string;
  subject: string;
  executedAt: string;
  outcome: OutcomeClass;
  detail: string;
  nextAction: string;
};

export const OUTCOME_LABEL: Record<OutcomeClass, string> = {
  progressed: "PROGRESSED",
  responded: "RESPONDED",
  no_response: "NO RESPONSE",
  unknown: "UNKNOWN",
};

export const OUTCOME_TONE: Record<OutcomeClass, string> = {
  progressed: "bg-success/15 text-success",
  responded: "bg-primary/15 text-primary",
  no_response: "bg-gold/15 text-gold-bright",
  unknown: "bg-muted text-muted-foreground",
};

/** Executive reading of the outcome — never a claim of business success. */
export const OUTCOME_INTERPRETATION: Record<OutcomeClass, string> = {
  progressed:
    "The action executed and the opportunity has measurably moved forward in the pipeline.",
  responded:
    "The action executed and the contact engaged, but the opportunity has not yet changed stage.",
  no_response:
    "The action executed successfully, but the lead has not demonstrated measurable progression.",
  unknown:
    "INSUFFICIENT DATA — the business outcome cannot be verified from the records available.",
};
