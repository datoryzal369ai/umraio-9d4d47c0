import { generateText, streamText, stepCountIs, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logAiEvent } from "./audit.server";
import { getAiConfig, type AiConfig } from "./config.server";
import { getProviderAdapter, type ProviderTransport } from "./providers.server";
import { classifyTask } from "./routing";
import type { AiDecision, AiRequest, AiResult, IntelligenceGateway } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * UMRAIO® AI Intelligence Layer — model-agnostic gateway.
 *
 * Application code calls this surface instead of a provider SDK. The gateway
 * depends only on the provider adapter interface (see providers.server.ts), so
 * swapping the foundation model — or dropping in a future RÉNAIO.CORE™ engine —
 * is a configuration change.
 *
 * This layer never fabricates a response: a provider failure, timeout or
 * invalid output returns `{ ok: false }` so callers can fall back to humans.
 */

const decisionSchema = z.object({
  intent: z.string(),
  confidence: z.number(),
  customer_state: z.string(),
  recommended_action: z.string(),
  reason_code: z.string(),
  required_tool: z.string().nullable(),
  response: z.string(),
  escalation_required: z.boolean(),
});

export type GatewayAuditBinding = {
  supabase: Db;
  agencyId: string;
  userId?: string | undefined;
};

function transportFor(request: AiRequest): ProviderTransport {
  return (request.taskClass ?? classifyTask(request.taskType)) === "fast" ? "fast" : "reasoning";
}

function timeoutFor(config: AiConfig, request: AiRequest, transport: ProviderTransport): number {
  if (request.taskType === "conversation_evaluation") return config.timeouts.evaluation;
  return transport === "fast" ? config.timeouts.fast : config.timeouts.reasoning;
}

function resolveModelId(config: AiConfig, transport: ProviderTransport): string {
  return transport === "fast" ? config.fastModel : config.model;
}

/**
 * P0-4: the final step of a tool-enabled run can be a tool step with no
 * assistant text, so `result.text` (final step only) is empty even though an
 * earlier assistant step produced the reply. Prefer the final text when
 * present; otherwise recover assistant text from any step in the run.
 */
async function extractRunText(result: {
  text: string | PromiseLike<string>;
  steps?: unknown;
}): Promise<string> {
  const finalText = (await result.text).trim();
  if (finalText) return finalText;
  try {
    const steps = await result.steps;
    if (Array.isArray(steps)) {
      const joined = steps
        .map((step) => {
          const text = (step as { text?: unknown } | null)?.text;
          return typeof text === "string" ? text.trim() : "";
        })
        .filter((text) => text.length > 0)
        .join("\n\n");
      if (joined) return joined;
    }
  } catch {
    // steps unavailable — fall through to the (empty) final text
  }
  return finalText;
}

function contextBlock(request: AiRequest): string {
  if (!request.context) return request.prompt;
  return [
    request.prompt,
    "",
    `Current time: ${request.context.now}`,
    request.context.locale ? `Language: ${request.context.locale}` : "",
    request.context.allowedTools.length
      ? `Permitted tools: ${request.context.allowedTools.join(", ")}`
      : "",
    "",
    "Context (JSON, authoritative — do not invent facts beyond this):",
    JSON.stringify(request.context.facts),
  ]
    .filter(Boolean)
    .join("\n");
}

function systemOption(request: AiRequest) {
  return request.system ? { system: request.system } : {};
}

class TimeoutError extends Error {
  constructor() {
    super("AI request exceeded its deadline");
    this.name = "TimeoutError";
  }
}

/** Only transient provider/transport failures may be retried or failed over. */
function isTransient(error: unknown): boolean {
  if (error instanceof TimeoutError) return false; // a deadline must not spawn duplicates
  if (NoObjectGeneratedError.isInstance(error)) return false;
  const status =
    (error as any)?.statusCode ?? (error as any)?.status ?? (error as any)?.response?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/\b(400|401|402|403|404|422)\b/.test(message)) return false;
  return /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|stream closed)/i.test(
    message,
  );
}

function errorCode(error: unknown): "unavailable" | "invalid_output" | "configuration" {
  if (NoObjectGeneratedError.isInstance(error)) return "invalid_output";
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("AI configuration error")) return "configuration";
  return "unavailable";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ExecuteArgs = {
  modelId: string;
  transport: ProviderTransport;
  signal: AbortSignal;
};

export function createIntelligenceGateway(audit?: GatewayAuditBinding): IntelligenceGateway {
  async function emit(
    request: AiRequest,
    event: "AI_REQUEST" | "AI_RESPONSE" | "AI_FAILURE",
    extra: {
      model?: string;
      provider?: string;
      status?: string;
      latencyMs?: number;
      reasonCode?: string;
      error?: string;
    } = {},
  ) {
    if (!audit || !request.context) return;
    await logAiEvent(audit.supabase, {
      agencyId: audit.agencyId,
      correlationId: request.context.correlationId,
      event,
      taskType: request.taskType,
      userId: audit.userId,
      ...extra,
    });
  }

  async function call<T>(
    request: AiRequest,
    execute: (args: ExecuteArgs) => Promise<T>,
  ): Promise<AiResult<T>> {
    let config: AiConfig;
    try {
      config = getAiConfig();
      getProviderAdapter(getAiConfig().provider); // validate provider up front
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI configuration error";
      await emit(request, "AI_FAILURE", { status: "configuration", error: message });
      return { ok: false, data: null, usage: null, error: { code: "configuration", message } };
    }

    const transport = transportFor(request);
    const timeoutMs = timeoutFor(config, request, transport);
    const primary = resolveModelId(config, transport);

    await emit(request, "AI_REQUEST", { model: primary, provider: config.provider });

    let lastError: unknown = null;
    let failedOver = false;

    for (const modelId of [primary, ...(config.fallbackModel ? [config.fallbackModel] : [])]) {
      // The fallback model is only for transient/provider-availability failures.
      if (failedOver && !isTransient(lastError)) break;

      for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
        const startedAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new TimeoutError()), timeoutMs);
        try {
          const data = await execute({ modelId, transport, signal: controller.signal });
          const latencyMs = Date.now() - startedAt;
          await emit(request, "AI_RESPONSE", {
            model: modelId,
            provider: config.provider,
            status: "ok",
            latencyMs,
          });
          return {
            ok: true,
            data,
            usage: { model: modelId, provider: config.provider, latencyMs },
          };
        } catch (error) {
          lastError = controller.signal.aborted ? new TimeoutError() : error;
          if (!isTransient(lastError)) break; // terminal: no retry, no fallback
          if (attempt < config.maxRetries) await sleep(500 * 2 ** attempt); // bounded backoff
        } finally {
          clearTimeout(timer);
        }
      }
      failedOver = true;
    }

    const code = errorCode(lastError);
    const message = lastError instanceof Error ? lastError.message : "AI provider unavailable";
    await emit(request, "AI_FAILURE", {
      model: primary,
      provider: config.provider,
      status: code,
      error: message,
    });
    return { ok: false, data: null, usage: null, error: { code, message } };
  }

  function model({ modelId, transport }: ExecuteArgs) {
    const provider = getProviderAdapter(getAiConfig().provider);
    return {
      model: provider.model(modelId, transport),
      providerOptions: provider.requestOptions(transport) as any,
    };
  }

  return {
    async generate(request) {
      return call(request, async (args) => {
        const { model: languageModel, providerOptions } = model(args);
        const promptOption = request.messages?.length
          ? { messages: request.messages as any }
          : { prompt: contextBlock(request) };

        const toolOption = request.tools
          ? { tools: request.tools as any, stopWhen: stepCountIs(request.maxSteps ?? 50) }
          : {};
        if (args.transport === "reasoning") {
          // Reasoning workloads stream on the wire (bounded by the deadline)
          // so long generations are never a single silent round-trip.
          const result = streamText({
            model: languageModel,
            ...systemOption(request),
            ...promptOption,
            ...toolOption,
            providerOptions,
            abortSignal: args.signal,
            maxRetries: 0,
          });
          return extractRunText(result);
        }
        const result = await generateText({
          model: languageModel,
          ...systemOption(request),
          ...promptOption,
          ...toolOption,
          providerOptions,
          abortSignal: args.signal,
          maxRetries: 0,
        });
        return extractRunText(result);
      });
    },

    async reason(request): Promise<AiResult<AiDecision>> {
      return call(request, async (args) => {
        const { model: languageModel, providerOptions } = model(args);
        const { output } = await generateText({
          model: languageModel,
          output: Output.object({ schema: decisionSchema }),
          ...systemOption(request),
          providerOptions,
          abortSignal: args.signal,
          maxRetries: 0,
          prompt: [
            contextBlock(request),
            "",
            "Return a decision envelope. `reason_code` must be a short auditable rationale",
            "(one sentence, no private reasoning). Set escalation_required = true when",
            "confidence is low, the request is unusual or sensitive, information is missing,",
            "or the customer asks for a human.",
          ].join("\n"),
        });
        return output as AiDecision;
      });
    },

    async classify(request) {
      const result = await call<string>(request, async (args) => {
        const { model: languageModel, providerOptions } = model(args);
        const { output } = await generateText({
          model: languageModel,
          output: Output.object({
            schema: z.object({ label: z.string(), confidence: z.number() }),
          }),
          ...systemOption(request),
          providerOptions,
          abortSignal: args.signal,
          maxRetries: 0,
          prompt: [
            contextBlock(request),
            "",
            `Choose exactly one label from: ${request.labels.join(", ")}.`,
          ].join("\n"),
        });
        return (output as { label: string }).label;
      });

      // Never silently coerce an out-of-set label into a valid one.
      if (result.ok && !request.labels.includes(result.data as string)) {
        return {
          ok: false,
          data: null,
          usage: result.usage,
          error: {
            code: "invalid_output",
            message: "Model returned a label outside the permitted set.",
          },
        };
      }
      return result;
    },

    async extract<T>(request: AiRequest & { schema: unknown }) {
      return call<T>(request, async (args) => {
        const { model: languageModel, providerOptions } = model(args);
        const { output } = await generateText({
          model: languageModel,
          output: Output.object({ schema: request.schema as z.ZodTypeAny }),
          ...systemOption(request),
          providerOptions,
          abortSignal: args.signal,
          maxRetries: 0,
          prompt: contextBlock(request),
        });
        return output as T;
      });
    },

    async evaluate(request) {
      return call(request, async (args) => {
        const { model: languageModel, providerOptions } = model(args);
        const { output } = await generateText({
          model: languageModel,
          output: Output.object({
            schema: z.object({ score: z.number(), reason_code: z.string() }),
          }),
          ...systemOption(request),
          providerOptions,
          abortSignal: args.signal,
          maxRetries: 0,
          prompt: [
            contextBlock(request),
            "",
            "Score the outcome from 0 (failed) to 100 (ideal) and give a short reason code.",
          ].join("\n"),
        });
        return output as { score: number; reason_code: string };
      });
    },

    async healthCheck() {
      const config = getAiConfig();
      try {
        const provider = getProviderAdapter(config.provider);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new TimeoutError()), config.timeouts.fast);
        try {
          const { text } = await generateText({
            model: provider.model(config.fastModel, "fast"),
            prompt: "Reply with OK.",
            providerOptions: provider.requestOptions("fast") as any,
            abortSignal: controller.signal,
            maxRetries: 0,
          });
          return { ok: text.trim().length > 0, provider: config.provider, model: config.fastModel };
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        return {
          ok: false,
          provider: config.provider,
          model: config.fastModel,
          message: error instanceof Error ? error.message : "unknown error",
        };
      }
    },
  };
}
