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
/* P0-4 FINAL — the !result.ok branch in sales-ai.server.ts            */
/*                                                                     */
/* generateAgentReply cannot be imported in tests (deep server graph), */
/* so these tests pin the branch contract two ways:                    */
/*  1. behavioural — the exact decision the branch makes via the same  */
/*     predicates/replies the branch calls;                            */
/*  2. structural — the branch source contains the live-quotation      */
/*     short-circuit before the AI_FAILURE throw.                      */
/* ------------------------------------------------------------------ */

describe("P0-4 FINAL — sales-ai !result.ok branch", () => {
  it("F. live-quotation rejection + !result.ok → deterministic reply, NOT silent, NOT ASR", () => {
    const resultOk = false; // gateway correctly failed the empty run
    const toolRecords = [
      {
        tool: "create_quotation",
        status: "rejected",
        reason: "This lead already has a live quotation. Discuss the existing quotation instead of issuing a new one.",
      },
    ];
    // Branch condition: do not throw.
    expect(resultOk).toBe(false);
    expect(isLiveQuotationRejection(toolRecords)).toBe(true);

    const reply = emptyCompletionReply({
      toolRecords,
      quotation: { quotationNumber: "QT-0042", status: "sent", totalMyr: 15500 },
    });
    expect(reply.length).toBeGreaterThan(0); // outbound reply exists — never silent
    expect(reply).not.toMatch(ASR_FALLBACK);
    expect(reply).toMatch(/masih aktif/i);
    expect(reply).toMatch(/QT-0042/);
    expect(reply).toMatch(/RM15,500/);
    expect(reply).not.toMatch(/baharu/); // never claims a new quotation was created
  });

  it("G. genuine gateway failure (no business-rule rejection) → throw path preserved", () => {
    const resultOk = false;
    const toolRecords = [
      {
        tool: "create_quotation",
        status: "rejected",
        reason: "upstream provider timeout", // NOT the live-quotation rule
      },
    ];
    expect(resultOk).toBe(false);
    // Branch condition false → AI_FAILURE throw path, no fabricated reply.
    expect(isLiveQuotationRejection(toolRecords)).toBe(false);
  });

  it("H. branch source: live-quotation short-circuit sits inside !result.ok before the throw", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/sales-ai.server.ts", "utf8");
    const branchStart = src.indexOf("if (!result.ok) {");
    expect(branchStart).toBeGreaterThan(-1);
    const throwIdx = src.indexOf('throw new Error(result.error?.message ?? "AI provider unavailable")');
    expect(throwIdx).toBeGreaterThan(branchStart);
    const shortCircuit = src.slice(branchStart, throwIdx);
    expect(shortCircuit).toContain("isLiveQuotationRejection(toolRecords)");
    expect(shortCircuit).toContain("return reply;");
    expect(shortCircuit).toContain("emptyCompletionReply({");
    // The short-circuit must not fabricate: it uses the deterministic helper only.
    expect(shortCircuit).not.toContain("streamText");
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
