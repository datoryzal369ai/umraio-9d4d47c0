/**
 * UMRAIO® AI Intelligence Layer — shared contracts.
 *
 * These interfaces are deliberately provider-agnostic so a future
 * RÉNAIO.CORE™ implementation can sit above or replace the current gateway
 * without touching application code. Nothing here implements autonomous
 * learning; it is a contract surface only.
 */

export type TaskClass = "fast" | "reasoning" | "deterministic";

export type AiTaskType =
  | "intent_classification"
  | "language_detection"
  | "entity_extraction"
  | "message_tagging"
  | "faq_classification"
  | "customer_reply"
  | "objection_handling"
  | "package_recommendation"
  | "next_best_action"
  | "conversation_analysis"
  | "conversation_evaluation"
  | "business_decision"
  | "content_generation";

/** Minimum-necessary, tenant-scoped context handed to the reasoning engine. */
export type AiContext = {
  agencyId: string;
  correlationId: string;
  locale?: string;
  now: string;
  /** Free-form, already-redacted business context. Never raw secrets. */
  facts: Record<string, unknown>;
  /** Tool names the caller permits for this request. */
  allowedTools: string[];
};

export type AiRequest = {
  taskType: AiTaskType;
  system?: string;
  prompt: string;
  context?: AiContext;
  /** Overrides the routing table when a caller must pin a class. */
  taskClass?: Exclude<TaskClass, "deterministic">;
  /**
   * Prior conversation turns. When provided they are sent as the message list
   * instead of a single prompt string. `content` may be a plain string or the
   * provider-supported multimodal content parts (text / image).
   */
  messages?: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;

  /**
   * Model-callable tools. These MUST be built with `createSdkTools()` so every
   * invocation passes through the ToolRegistry decision gate.
   */
  tools?: Record<string, unknown>;
  /** Maximum tool-loop steps when `tools` is supplied. */
  maxSteps?: number;
};

export type AiUsage = { model: string; provider: string; latencyMs: number };

export type AiResult<T = string> = {
  ok: boolean;
  data: T | null;
  usage: AiUsage | null;
  /** Populated when ok === false. Never fabricated content. */
  error?: {
    code: "unavailable" | "invalid_output" | "rejected" | "configuration" | "unknown";
    message: string;
  };
};

/**
 * Structured decision envelope for complex tasks.
 * `reason_code` is a concise audit rationale — never hidden chain-of-thought.
 */
export type AiDecision = {
  intent: string;
  confidence: number;
  customer_state: string;
  recommended_action: string;
  reason_code: string;
  required_tool: string | null;
  response: string;
  escalation_required: boolean;
};

export interface IntelligenceGateway {
  generate(request: AiRequest): Promise<AiResult<string>>;
  reason(request: AiRequest): Promise<AiResult<AiDecision>>;
  classify(request: AiRequest & { labels: string[] }): Promise<AiResult<string>>;
  extract<T>(request: AiRequest & { schema: unknown }): Promise<AiResult<T>>;
  evaluate(request: AiRequest): Promise<AiResult<{ score: number; reason_code: string }>>;
  healthCheck(): Promise<{ ok: boolean; provider: string; model: string; message?: string }>;
}
