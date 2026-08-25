/**
 * UMRAIO® AI Intelligence Layer (V1) — server-only barrel.
 *
 * Application code should import from here rather than a model provider SDK.
 * Nothing in this layer is wired into existing features yet; the current
 * sales-ai and executive-ai paths continue to run unchanged.
 */

export * from "./types";
export * from "./routing";
export {
  getAiConfig,
  getProviderApiKey,
  describeAiConfig,
  type AiConfig,
  type AiConfigDiagnostic,
  type AiProviderId,
} from "./config.server";
export {
  getProviderAdapter,
  isSupportedProvider,
  registerProviderAdapter,
  listProviderIds,
  resolveProviderId,
  type ProviderAdapter,
  type ProviderTransport,
} from "./providers.server";

export { createIntelligenceGateway, type GatewayAuditBinding } from "./gateway.server";
export { buildContext, loadBusinessMemory, newCorrelationId } from "./context.server";
export {
  ToolRegistry,
  createToolRegistry,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolOutcome,
  type ToolPermission,
  type ToolRejectionStage,
} from "./tool-registry.server";
export { createSdkTools, type SdkToolAdapterOptions } from "./sdk-tools.server";
export { logAiEvent, type AiAuditEvent, type AiAuditPayload } from "./audit.server";
export { recordExperience, hashContext, type ExperienceRecord } from "./evaluation.server";
export { redactText, redactAndCap, redactDeep } from "./redaction";
