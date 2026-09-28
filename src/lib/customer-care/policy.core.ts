export type CustomerCareCategory =
  | "routine"
  | "booking"
  | "billing"
  | "legal"
  | "security"
  | "religious_high_risk"
  | "human_request";

export type CustomerCarePolicyDecision =
  | "AUTO_ALLOWED"
  | "APPROVAL_REQUIRED"
  | "HUMAN_HANDOFF";

export type CustomerCarePolicy = {
  category: CustomerCareCategory;
  decision: CustomerCarePolicyDecision;
  reasonCode: string;
};

const any = (text: string, patterns: RegExp[]) => patterns.some((p) => p.test(text));

const HUMAN = [
  /\bhuman\b/i,
  /\breal person\b/i,
  /\bstaff\b/i,
  /\bagent\b/i,
  /\bmanusia\b/i,
  /\bstaf\b/i,
  /\bpegawai\b/i,
];

const LEGAL = [
  /\blegal\b/i,
  /\blawyer\b/i,
  /\bsolicitor\b/i,
  /\bregulator\b/i,
  /\bregulatory\b/i,
  /\bcomplaint\b/i,
  /\bdefamation\b/i,
  /\bcease and desist\b/i,
  /\bsurat peguam\b/i,
  /\badenan\b/i,
];

const SECURITY = [
  /\bpassword\b/i,
  /\b2fa\b/i,
  /\bhacked\b/i,
  /\bcompromised\b/i,
  /\baccount takeover\b/i,
  /\bdelete (?:my )?account\b/i,
  /\bchange (?:my )?email\b/i,
  /\bkata laluan\b/i,
  /\bdigodam\b/i,
];

const BILLING = [
  /\brefund\b/i,
  /\bchargeback\b/i,
  /\bbilling dispute\b/i,
  /\bpayment dispute\b/i,
  /\bpricing exception\b/i,
  /\bdiscount approval\b/i,
  /\bbayaran balik\b/i,
  /\bpertikaian bayaran\b/i,
];

const BOOKING_IRREVERSIBLE = [
  /\bcancel (?:my )?booking\b/i,
  /\bbooking cancellation\b/i,
  /\bcancel my umrah\b/i,
  /\bbatalkan tempahan\b/i,
  /\bbatal tempahan\b/i,
];

const RELIGIOUS_HIGH_RISK = [
  /\bfatwa\b/i,
  /\bhalal certification\b/i,
  /\bshariah ruling\b/i,
  /\bhukum syarak\b/i,
  /\bharam or halal\b/i,
];

export function classifyCustomerCarePolicy(raw: string): CustomerCarePolicy {
  const text = raw.trim();

  if (any(text, HUMAN)) {
    return {
      category: "human_request",
      decision: "HUMAN_HANDOFF",
      reasonCode: "CUSTOMER_REQUESTED_HUMAN",
    };
  }
  if (any(text, LEGAL)) {
    return {
      category: "legal",
      decision: "APPROVAL_REQUIRED",
      reasonCode: "LEGAL_APPROVAL_REQUIRED",
    };
  }
  if (any(text, SECURITY)) {
    return {
      category: "security",
      decision: "APPROVAL_REQUIRED",
      reasonCode: "SECURITY_APPROVAL_REQUIRED",
    };
  }
  if (any(text, BILLING)) {
    return {
      category: "billing",
      decision: "APPROVAL_REQUIRED",
      reasonCode: "BILLING_COMMITMENT_APPROVAL_REQUIRED",
    };
  }
  if (any(text, BOOKING_IRREVERSIBLE)) {
    return {
      category: "booking",
      decision: "APPROVAL_REQUIRED",
      reasonCode: "BOOKING_CANCELLATION_APPROVAL_REQUIRED",
    };
  }
  if (any(text, RELIGIOUS_HIGH_RISK)) {
    return {
      category: "religious_high_risk",
      decision: "APPROVAL_REQUIRED",
      reasonCode: "QUALIFIED_REVIEW_REQUIRED",
    };
  }

  return {
    category: "routine",
    decision: "AUTO_ALLOWED",
    reasonCode: "ROUTINE_CUSTOMER_CARE",
  };
}

export const UMRAIO_CUSTOMER_CARE_INSTRUCTION = `
CUSTOMER CARE MODE — 24/7:
You are also the agency's customer-care executive, not only a sales closer. Answer routine after-sales,
booking-status, onboarding, package, document, itinerary, payment-guidance and UMRAIO support questions
from verified agency/platform context. Never fabricate a payment, booking, refund, cancellation, document
submission, visa status or staff action. Legal/regulatory correspondence, refunds/payment disputes,
booking cancellation, account-security changes, exceptional commercial commitments and high-risk
religious rulings require human approval or qualified review. If the customer explicitly asks for a human,
honour the existing handover flow. Keep helping with safe verified information while escalation is pending.
`.trim();

export function isAutonomousEmailCareEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env["CUSTOMER_CARE_EMAIL_AUTONOMOUS_ENABLED"]?.trim().toLowerCase() === "true";
}
