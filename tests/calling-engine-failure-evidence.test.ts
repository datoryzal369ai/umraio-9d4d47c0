import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError, JSONParseError, LoadAPIKeyError } from "@ai-sdk/provider";
import { NoOutputGeneratedError } from "ai";
import { packetFixture, decisionFixture } from "./helpers/calling-cognitive-fixtures";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn(), options: vi.fn(), config: vi.fn() }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: mocks.generate }));
vi.mock("../src/lib/ai/config.server", () => ({ getAiConfig: mocks.config }));
vi.mock("../src/lib/ai/providers.server", () => ({ getProviderAdapter: () => ({ model: mocks.model, requestOptions: mocks.options }) }));
import { currentCallingEngine, CallingEngineFailure } from "../src/lib/calls/cognitive-engine.server";

const privateValue = "PRIVATE_PROMPT_CUSTOMER_KEY_OUTPUT_DO_NOT_RETAIN";
const apiError = (statusCode?: number) => new APICallError({ message: privateValue, url: `https://example.invalid/${privateValue}`,
  requestBodyValues: { prompt: privateValue }, responseHeaders: { authorization: privateValue }, responseBody: privateValue,
  ...(statusCode === undefined ? {} : { statusCode }) });
const packet = () => packetFixture(`Nama saya ${privateValue}`);
beforeEach(() => {
  mocks.config.mockReturnValue({ provider: "current-provider", model: "current-model", timeouts: { reasoning: 90000 } });
  mocks.model.mockReturnValue("unchanged-model"); mocks.options.mockReturnValue({ openai: { store: false } });
});
afterEach(() => vi.resetAllMocks());
async function invoke(p = packet(), signal = new AbortController().signal, deadline = Date.now() + 1000) {
  return currentCallingEngine.decide({ packet: p, signal, deadline });
}
async function failure(p = packet()) {
  const error = await invoke(p).catch(e => e);
  expect(error).toBeInstanceOf(CallingEngineFailure);
  expect(JSON.stringify(error)).not.toContain(privateValue);
  expect(error.message).toBe("calling_cognitive_invocation_failed");
  expect(error.failure).toMatchObject({ validation_stage: "before_semantic_validation", correlation_id: expect.stringMatching(/^[a-f0-9]{64}$/), elapsed_ms: expect.any(Number) });
  expect(error.failure.elapsed_ms).toBeGreaterThanOrEqual(0);
  return error as CallingEngineFailure;
}

describe("sanitized engine failures, without a provider request or retry", () => {
  it("retains an allowlisted provider rejection without any quoted private content", async () => {
    const e = apiError(400);
    Object.assign(e, { data: { error: { code: "invalid_json_schema", type: "invalid_request_error", param: "text.format.schema",
      message: `Invalid schema. Missing 'clarification'. ${privateValue} authorization: Bearer private-token user@example.invalid +60123456789` } } });
    mocks.generate.mockRejectedValue(e);
    expect((await failure()).failure).toMatchObject({ provider_error_code: "invalid_json_schema", provider_error_type: "invalid_request_error",
      provider_error_parameter: "text.format.schema", provider_diagnostic: "Provider rejected the structured-output schema. Missing required field: clarification." });
  });
  it.each(["code", "type", "param", "message"])("does not copy arbitrary provider %s text", async field => {
    const e = apiError(400); Object.assign(e, { data: { error: { [field]: privateValue } } }); mocks.generate.mockRejectedValue(e);
    const result = (await failure()).failure;
    expect(result).toMatchObject({ provider_error_code: null, provider_error_type: null, provider_error_parameter: null, provider_diagnostic: null });
  });
  it("withholds unknown schema paths and missing fields, including names embedded in provider messages", async () => {
    const e = apiError(400); Object.assign(e, { data: { error: { code: "invalid_json_schema", type: "invalid_request_error",
      param: `text.format.schema.${privateValue}`, message: `Missing '${privateValue}'.` } } }); mocks.generate.mockRejectedValue(e);
    expect((await failure()).failure).toMatchObject({ provider_error_parameter: null, provider_diagnostic: "Provider rejected the structured-output schema." });
  });
  it("retains the safe unsupported-parameter category independently of schema rejection", async () => {
    const e = apiError(400); Object.assign(e, { data: { error: { code: "unsupported_parameter", type: "invalid_request_error", param: "temperature", message: privateValue } } });
    mocks.generate.mockRejectedValue(e);
    expect((await failure()).failure).toMatchObject({ provider_error_code: "unsupported_parameter", provider_error_parameter: "temperature",
      provider_diagnostic: "Provider rejected an unsupported request parameter." });
  });
  it.each([400, 401, 429, 500, 503])("retains HTTP %i without request, output, header or message content", async status => {
    mocks.generate.mockRejectedValue(apiError(status));
    expect((await failure()).failure).toMatchObject({ failure_class: "PROVIDER_HTTP_ERROR", failure_stage: "provider_request",
      failure_type: "AI_APICallError", provider_http_status: status, cancelled: false, timed_out: false });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("retains an unavailable transport separately from an HTTP response", async () => {
    mocks.generate.mockRejectedValue(apiError());
    expect((await failure()).failure).toMatchObject({ failure_class: "PROVIDER_UNAVAILABLE", provider_http_status: null });
  });
  it("identifies missing provider access at model setup without logging credentials", async () => {
    mocks.model.mockImplementation(() => { throw new LoadAPIKeyError({ message: privateValue }); });
    expect((await failure()).failure).toMatchObject({ failure_class: "PROVIDER_UNAVAILABLE", failure_stage: "model_setup" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each([408, 504])("separates HTTP %i provider timeouts from request cancellation", async status => {
    mocks.generate.mockRejectedValue(apiError(status));
    expect((await failure()).failure).toMatchObject({ failure_class: "PROVIDER_TIMEOUT", provider_http_status: status, timed_out: true, cancelled: false });
  });
  it("classifies the actual bounded provider deadline", async () => {
    mocks.generate.mockImplementation(({ abortSignal }) => new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })));
    const error = await invoke(packet(), new AbortController().signal, Date.now() + 30).catch(e => e);
    expect(error.failure).toMatchObject({ failure_class: "PROVIDER_TIMEOUT", failure_stage: "provider_request", timed_out: true, cancelled: false });
    expect(error.metadata.cancellation).toBe("model_timeout");
  });
  it("classifies structured output parsing without retaining the rejected text", async () => {
    mocks.generate.mockRejectedValue(new JSONParseError({ text: privateValue, cause: new SyntaxError(privateValue) }));
    expect((await failure()).failure).toMatchObject({ failure_class: "STRUCTURED_OUTPUT_PARSE", failure_stage: "structured_output_parse", failure_type: "AI_JSONParseError" });
  });
  it("captures lazy structured-output parsing errors", async () => {
    mocks.generate.mockResolvedValue({ get output() { throw new NoOutputGeneratedError({ message: privateValue }); } });
    expect((await failure()).failure).toMatchObject({ failure_class: "STRUCTURED_OUTPUT_PARSE", failure_stage: "structured_output_parse" });
  });
  it("distinguishes local binding from SDK parsing and semantic validation", async () => {
    const p = packet();
    mocks.generate.mockResolvedValue({ output: { ...decisionFixture(p), authoritative_facts_used: [privateValue] } });
    const error = await invoke(p).catch(e => e);
    expect(error.failure).toMatchObject({ failure_class: "STRUCTURED_OUTPUT_BINDING", failure_stage: "structured_output_binding", failure_type: "ZodError" });
    expect(JSON.stringify(error)).not.toContain(privateValue);
  });
  it("distinguishes supersession/caller cancellation from provider timeout", async () => {
    const abort = new AbortController();
    mocks.generate.mockImplementation(({ abortSignal }) => new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })));
    const pending = invoke(packet(), abort.signal); abort.abort(new DOMException(privateValue, "AbortError"));
    const error = await pending.catch(e => e);
    expect(error.failure).toMatchObject({ failure_class: "REQUEST_CANCELLED", cancelled: true, timed_out: false });
    expect(error.name).toBe("AbortError"); expect(JSON.stringify(error)).not.toContain(privateValue);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("retains internal configuration stage with an allowlisted error type", async () => {
    mocks.config.mockImplementation(() => { const e = new Error(privateValue); e.name = privateValue; throw e; });
    expect((await failure()).failure).toMatchObject({ failure_class: "ENGINE_INTERNAL", failure_stage: "configuration", failure_type: "Error" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("retains unexpected result-metadata errors after binding without changing the successful result", async () => {
    const p = packet();
    mocks.generate.mockResolvedValue({ output: decisionFixture(p), get response() { throw new TypeError(privateValue); } });
    expect((await failure(p)).failure).toMatchObject({ failure_class: "ENGINE_INTERNAL", failure_stage: "engine_result", failure_type: "TypeError" });
  });
  it("distinguishes a response-budget deadline from caller cancellation", async () => {
    const abort = new AbortController();
    mocks.generate.mockImplementation(({ abortSignal }) => new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })));
    const pending = invoke(packet(), abort.signal); abort.abort(new DOMException(privateValue, "TimeoutError"));
    const error = await pending.catch(e => e);
    expect(error.failure).toMatchObject({ failure_class: "PROVIDER_TIMEOUT", timed_out: true, cancelled: false });
    expect(error.metadata.cancellation).toBe("model_timeout");
    expect(JSON.stringify(error)).not.toContain(privateValue);
  });
  it("follows a bounded nested cause without retaining the cause or repeating work", async () => {
    mocks.generate.mockRejectedValue(new Error(privateValue, { cause: apiError(429) }));
    expect((await failure()).failure).toMatchObject({ failure_class: "PROVIDER_HTTP_ERROR", provider_http_status: 429 });
  });
  it("correlates the same owned turn deterministically without hashing caller content", async () => {
    mocks.generate.mockRejectedValue(apiError(503)); const p = packet();
    const a = await invoke(p).catch(e => e);
    p.current_call.current_caller.transcript = "Different caller content";
    const b = await invoke(p).catch(e => e);
    expect(a.failure.correlation_id).toBe(b.failure.correlation_id);
    p.identity.generation = "new-generation";
    const c = await invoke(p).catch(e => e);
    expect(c.failure.correlation_id).not.toBe(a.failure.correlation_id);
  });
  it("keeps the successful bound decision, configuration, options and invocation count unchanged", async () => {
    const p = packet(); const d = decisionFixture(p);
    mocks.generate.mockResolvedValue({ output: d, response: { modelId: "served-model" }, usage: { inputTokens: 31, outputTokens: 17 } });
    const result = await invoke(p);
    expect(result.decision).toEqual(d);
    expect(result.metadata).toMatchObject({ configured_provider: "current-provider", configured_model: "current-model", returned_model: "served-model", input_tokens: 31, output_tokens: 17, fallback: false, cancellation: null });
    expect(result.metadata).not.toHaveProperty("failure");
    expect(mocks.model).toHaveBeenCalledExactlyOnceWith("current-model", "reasoning");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0]![0]).toMatchObject({ prompt: JSON.stringify(p), providerOptions: { openai: { store: false } }, maxRetries: 0 });
    expect(mocks.generate.mock.calls[0]![0].tools).toBeUndefined();
  });
});
