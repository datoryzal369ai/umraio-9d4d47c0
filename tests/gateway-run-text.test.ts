import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0-4 — empty-AI-reply extraction regression.
 *
 * When the gateway's reasoning/streaming path runs with tools and the final
 * step is a tool step (e.g. search_knowledge) with no assistant text,
 * `result.text` is empty even though an earlier assistant step produced the
 * reply. The gateway must recover assistant text from the whole run; a
 * genuinely empty run must still return "" so existing caller fallbacks
 * (e.g. sales-ai "boleh ulang sekali lagi") keep working.
 */

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
    generateText: (...args: unknown[]) => generateTextMock(...args),
  };
});

vi.mock("../src/lib/ai/providers.server", () => ({
  getProviderAdapter: () => ({
    model: () => "mock-model",
    requestOptions: () => ({}),
  }),
}));

vi.mock("../src/lib/ai/config.server", () => ({
  getAiConfig: () => ({
    provider: "openai",
    model: "gpt-test",
    fastModel: "gpt-test-fast",
    timeouts: { fast: 5000, reasoning: 30000, evaluation: 5000 },
    maxRetries: 0,
  }),
}));

vi.mock("../src/lib/ai/routing", () => ({
  classifyTask: () => "reasoning",
}));

import { createIntelligenceGateway } from "../src/lib/ai/gateway.server";

const baseRequest = {
  taskType: "sales_reply",
  prompt: "Pelanggan tanya pakej umrah.",
  tools: {
    search_knowledge: {
      description: "Search knowledge base",
      inputSchema: {},
    },
  },
} as any;

describe("P0-4 gateway run-text extraction", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
  });

  it("recovers assistant text from an earlier step when the final tool step has none (reasoning path)", async () => {
    streamTextMock.mockReturnValue({
      text: Promise.resolve(""), // final step: tool call only
      steps: Promise.resolve([
        { text: "" }, // tool step
        { text: "Baik Datuk, pakej ekonomi bermula dari RM6,900." }, // assistant step
      ]),
    });

    const gateway = createIntelligenceGateway();
    const result = await gateway.generate(baseRequest);

    expect(result.ok).toBe(true);
    expect(result.data).toBe("Baik Datuk, pakej ekonomi bermula dari RM6,900.");
  });

  it("keeps the normal final-step response unchanged (reasoning path)", async () => {
    streamTextMock.mockReturnValue({
      text: Promise.resolve("Normal reply from final step"),
      steps: Promise.resolve([{ text: "Normal reply from final step" }]),
    });

    const gateway = createIntelligenceGateway();
    const result = await gateway.generate(baseRequest);

    expect(result.ok).toBe(true);
    expect(result.data).toBe("Normal reply from final step");
  });

  it("returns empty text for a genuinely empty run so caller fallbacks still apply (reasoning path)", async () => {
    streamTextMock.mockReturnValue({
      text: Promise.resolve(""),
      steps: Promise.resolve([{ text: "" }, { text: "   " }]),
    });

    const gateway = createIntelligenceGateway();
    const result = await gateway.generate(baseRequest);

    expect(result.ok).toBe(true);
    expect(result.data).toBe("");
  });

  it("applies the same recovery on the generateText (fast) path", async () => {
    generateTextMock.mockResolvedValue({
      text: "", // final step: tool call only
      steps: [{ text: "Fast-path assistant reply dari step awal" }],
    });

    const gateway = createIntelligenceGateway();
    const result = await gateway.generate({ ...baseRequest, taskClass: "fast" } as any);

    expect(generateTextMock).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.data).toBe("Fast-path assistant reply dari step awal");
  });

  it("keeps the normal final-step response unchanged (fast path)", async () => {
    generateTextMock.mockResolvedValue({
      text: "Fast normal reply",
      steps: [{ text: "Fast normal reply" }],
    });

    const gateway = createIntelligenceGateway();
    const result = await gateway.generate({ ...baseRequest, taskClass: "fast" } as any);

    expect(result.ok).toBe(true);
    expect(result.data).toBe("Fast normal reply");
  });

  it("returns empty text for a genuinely empty run (fast path)", async () => {
    generateTextMock.mockResolvedValue({
      text: "",
      steps: [{ text: "" }],
    });

    const gateway = createIntelligenceGateway();
    const result = await gateway.generate({ ...baseRequest, taskClass: "fast" } as any);

    expect(result.ok).toBe(true);
    expect(result.data).toBe("");
  });
});
