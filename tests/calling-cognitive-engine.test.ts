import { afterEach, describe, expect, it, vi } from "vitest";
import { packetFixture, decisionFixture } from "./helpers/calling-cognitive-fixtures";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn(), options: vi.fn() }));
vi.mock("ai", () => ({ generateText: mocks.generate, Output: { object: (value: unknown) => value } }));
vi.mock("../src/lib/ai/config.server", () => ({ getAiConfig: () => ({ provider: "current-provider", model: "current-runtime-model", fastModel: "do-not-use-fast", fallbackModel: "do-not-use-fallback", timeouts: { reasoning: 90000 } }) }));
vi.mock("../src/lib/ai/providers.server", () => ({ getProviderAdapter: () => ({ model: mocks.model, requestOptions: mocks.options }) }));
import { currentCallingEngine } from "../src/lib/calls/cognitive-engine.server";

describe("Calling engine preserves resolved model and a single invocation", () => {
  afterEach(() => { vi.clearAllMocks(); });
  it("returns a decision and draft together, with returned model/usage telemetry", async () => {
    const packet = packetFixture();
    mocks.model.mockReturnValue("unchanged-model-handle"); mocks.options.mockReturnValue({ existing: true });
    mocks.generate.mockResolvedValue({ output: decisionFixture(packet), response: { modelId: "actual-model-snapshot" }, usage: { inputTokens: 1250, outputTokens: 260 } });
    const result = await currentCallingEngine.decide({ packet, signal: new AbortController().signal, deadline: Date.now() + 1000 });
    expect(mocks.model).toHaveBeenCalledExactlyOnceWith("current-runtime-model", "reasoning");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const args = mocks.generate.mock.calls[0]![0];
    expect(args.prompt).toBe(JSON.stringify(packet)); expect(args.providerOptions).toEqual({ existing: true });
    expect(args.tools).toBeUndefined(); expect(args.maxRetries).toBe(0);
    expect(result.metadata).toMatchObject({ configured_provider: "current-provider", configured_model: "current-runtime-model", returned_model: "actual-model-snapshot", input_tokens: 1250, output_tokens: 260, fallback: false });
  });
  it("passes cancellation to actual model I/O and does not retry stale output", async () => {
    const packet = packetFixture(); const abort = new AbortController();
    mocks.generate.mockImplementation(({ abortSignal }) => new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })));
    const result = currentCallingEngine.decide({ packet, signal: abort.signal, deadline: Date.now() + 1000 });
    abort.abort(new DOMException("Superseded caller turn", "AbortError"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
});
