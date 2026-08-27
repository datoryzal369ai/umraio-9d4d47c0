import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_COMPLETION_HOLDING_MESSAGE,
  emptyCompletionReply,
  existingQuotationReply,
  isLiveQuotationRejection,
} from "@/lib/quotations/closing.core";
import { VOICE_INAUDIBLE_MESSAGE, fallbackMessageFor } from "@/lib/voice/limits.core";

const ASR_FALLBACK = /tak dapat tangkap tadi/i;

describe("P0-4 — empty AI completion never uses the ASR apology", () => {
  it("A. create_quotation rejected by a live quotation → helpful existing-quotation reply", () => {
    const records = [
      { tool: "recommend_packages", status: "executed" },
      {
        tool: "create_quotation",
        status: "rejected",
        reason: "This lead already has a live quotation. Discuss the existing quotation instead of issuing a new one.",
      },
    ];
    expect(isLiveQuotationRejection(records)).toBe(true);

    const reply = emptyCompletionReply({
      toolRecords: records,
      quotation: { quotationNumber: "QT-0007", status: "sent", totalMyr: 20700 },
    });

    expect(reply).not.toMatch(ASR_FALLBACK);
    expect(reply).toMatch(/masih aktif/i);
    expect(reply).toMatch(/QT-0007/);
    expect(reply).not.toMatch(/quotation baharu telah|berjaya dikeluarkan/i);
  });

  it("A2. works without quotation details (no fabricated figures)", () => {
    const reply = existingQuotationReply(null);
    expect(reply).not.toMatch(ASR_FALLBACK);
    expect(reply).not.toMatch(/RM/);
  });

  it("B. generic empty completion → neutral holding reply", () => {
    const reply = emptyCompletionReply({ toolRecords: [], quotation: null });
    expect(reply).toBe(EMPTY_COMPLETION_HOLDING_MESSAGE);
    expect(reply).not.toMatch(ASR_FALLBACK);
  });

  it("B2. an executed create_quotation is not treated as a rejection", () => {
    expect(isLiveQuotationRejection([{ tool: "create_quotation", status: "executed" }])).toBe(false);
  });

  it("C. true ASR-empty transcript keeps the voice-specific fallback", () => {
    expect(fallbackMessageFor("inaudible")).toBe(VOICE_INAUDIBLE_MESSAGE);
  });
});

/* ------------------------------------------------------------------ */
/* D/E — gateway stream-error handling                                 */
/* ------------------------------------------------------------------ */

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
  getProviderAdapter: () => ({ model: () => "mock-model", requestOptions: () => ({}) }),
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

vi.mock("../src/lib/ai/routing", () => ({ classifyTask: () => "reasoning" }));

const { createIntelligenceGateway } = await import("../src/lib/ai/gateway.server");

const baseRequest = {
  taskType: "sales_reply",
  prompt: "Saya nak quotation",
  tools: { create_quotation: { description: "x", inputSchema: {} } },
} as any;

describe("P0-4 — gateway stream errors are not successful empty runs", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
  });

  it("D. stream error after a tool step → gateway failure", async () => {
    streamTextMock.mockImplementation((options: any) => {
      options.onError?.({ error: new Error("upstream follow-up failed") });
      return { text: Promise.resolve(""), steps: Promise.resolve([{ text: "" }]) };
    });

    const result = await createIntelligenceGateway().generate(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/upstream follow-up failed/);
  });

  it("E. a normal assistant response is unchanged", async () => {
    streamTextMock.mockReturnValue({
      text: Promise.resolve("Baik Dato', ini pakejnya."),
      steps: Promise.resolve([{ text: "Baik Dato', ini pakejnya." }]),
    });

    const result = await createIntelligenceGateway().generate(baseRequest);
    expect(result.ok).toBe(true);
    expect(result.data).toBe("Baik Dato', ini pakejnya.");
  });

  it("E2. a genuinely completed empty run still succeeds with empty text", async () => {
    streamTextMock.mockReturnValue({
      text: Promise.resolve(""),
      steps: Promise.resolve([{ text: "" }]),
    });

    const result = await createIntelligenceGateway().generate(baseRequest);
    expect(result.ok).toBe(true);
    expect(result.data).toBe("");
  });
});
