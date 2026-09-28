import type { SupabaseClient } from "@supabase/supabase-js";

import { buildContext, createIntelligenceGateway, redactAndCap } from "@/lib/ai/index.server";
import { classifyCustomerCarePolicy } from "./policy.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type SupportEmailDraft = {
  reply: string;
  confidence: number;
  escalationRequired: boolean;
  requiresApproval: boolean;
  reasonCode: string;
  category: string;
};

const SYSTEM = `
You are UMRAIO® Autonomous Customer Care for an Umrah agency.
Handle routine customer care, onboarding, package questions, after-sales support, booking-status questions,
document guidance, itinerary questions, payment guidance and UMRAIO platform support using only the
verified context supplied by the application.
Never invent package availability, visa status, payment receipt, booking confirmation, refund, cancellation,
document submission, staff action or external email action.
Legal/regulatory correspondence, refund/payment disputes, booking cancellation, security changes,
exceptional commercial commitments and high-risk religious rulings require human approval.
If information is missing, say what is unknown and escalate instead of fabricating.
Write a concise, professional email reply in the customer's language when clear.
Do not expose private reasoning or credentials.
`.trim();

export async function draftSupportEmailReply(
  supabase: Db,
  input: {
    agencyId: string;
    subject: string;
    body: string;
    locale?: string;
  },
): Promise<SupportEmailDraft> {
  const policy = classifyCustomerCarePolicy(`${input.subject}\n${input.body}`);
  const context = await buildContext(supabase, {
    agencyId: input.agencyId,
    allowedTools: [],
    locale: input.locale,
    includePackages: true,
    historyLimit: 0,
  });

  const gateway = createIntelligenceGateway({
    supabase,
    agencyId: input.agencyId,
  });

  const result = await gateway.reason({
    taskType: "customer_reply",
    taskClass: "reasoning",
    system: SYSTEM,
    prompt: [
      `Subject: ${redactAndCap(input.subject, 500) ?? ""}`,
      "Customer email:",
      redactAndCap(input.body, 8000) ?? "",
      "",
      `Policy category: ${policy.category}`,
      `Policy decision: ${policy.decision}`,
      "Produce a reply draft. Set escalation_required=true whenever approval or missing verified information is required.",
    ].join("\n"),
    context,
  });

  if (!result.ok || !result.data) {
    return {
      reply:
        "Thank you for contacting us. I’m unable to verify a safe answer automatically, so this has been marked for human follow-up.",
      confidence: 0,
      escalationRequired: true,
      requiresApproval: true,
      reasonCode: result.error?.code ?? "INTELLIGENCE_UNAVAILABLE",
      category: policy.category,
    };
  }

  const reply = result.data.response.trim();
  if (!reply) {
    return {
      reply:
        "Thank you for contacting us. I’m unable to verify a safe answer automatically, so this has been marked for human follow-up.",
      confidence: 0,
      escalationRequired: true,
      requiresApproval: true,
      reasonCode: "EMPTY_MODEL_REPLY",
      category: policy.category,
    };
  }

  return {
    reply,
    confidence: result.data.confidence,
    escalationRequired: result.data.escalation_required,
    requiresApproval:
      policy.decision !== "AUTO_ALLOWED" ||
      result.data.escalation_required ||
      result.data.confidence < 0.78,
    reasonCode: result.data.reason_code || policy.reasonCode,
    category: policy.category,
  };
}
