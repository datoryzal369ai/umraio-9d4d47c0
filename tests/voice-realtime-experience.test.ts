/**
 * P0/P1 realtime calling experience: greeting-first + one-time disclosure,
 * natural closing state machine (never a crude silence hang-up), latency
 * accounting, and cross-channel relationship memory hydration.
 */
import { describe, expect, it } from "vitest";
import {
  advanceClosing,
  appendLatency,
  buildCallOpening,
  readClosingState,
  summarizeLatency,
  type TurnLatency,
} from "@/lib/calls/call-experience.core";
import { hydrateCallerContext, EMPTY_CALLER_CONTEXT } from "@/lib/calls/call-context.server";

describe("call opening", () => {
  it("greets first with the tenant name and speaks the disclosure once", () => {
    const first = buildCallOpening({ agencyName: "UMRAX TRAVEL", language: "ms-MY" });
    expect(first.text).toContain("UMRAX TRAVEL");
    expect(first.text).toContain("dirakam");
    expect(first.text).toContain("RAIŌ");
    expect(first.disclosureSpoken).toBe(true);

    const repeat = buildCallOpening({
      agencyName: "UMRAX TRAVEL",
      language: "ms-MY",
      disclosureAlreadySpoken: true,
    });
    expect(repeat.text).not.toContain("dirakam");
  });

  it("mirrors English callers", () => {
    const opening = buildCallOpening({ agencyName: "UMRAX", language: "en-US" });
    expect(opening.text).toContain("may be recorded");
  });
});

describe("closing state machine", () => {
  const base = { language: "ms-MY", turnCount: 4, maxTurns: 60 } as const;

  it("asks a completion check before ending, never ends straight away", () => {
    const step = advanceClosing({ ...base, state: "active", transcript: "Ok terima kasih" });
    expect(step.action).toBe("completion_check");
    expect(step.state).toBe("completion_check");
    if (step.action === "completion_check") expect(step.text.length).toBeGreaterThan(10);
  });

  it("continues when the caller still has a question", () => {
    const step = advanceClosing({
      ...base,
      state: "completion_check",
      transcript: "Ada satu lagi soalan pasal harga",
    });
    expect(step.action).toBe("continue");
    expect(step.state).toBe("active");
  });

  it("says farewell only after explicit confirmation", () => {
    const step = advanceClosing({ ...base, state: "completion_check", transcript: "Tak ada dah" });
    expect(step.action).toBe("farewell");
  });

  it("never terminates while governed work is pending", () => {
    const step = advanceClosing({
      ...base,
      state: "active",
      transcript: "Ok terima kasih",
      pendingWork: true,
    });
    expect(step.action).toBe("continue");
  });

  it("still speaks a farewell at the hard turn ceiling", () => {
    const step = advanceClosing({ ...base, state: "active", transcript: "", turnCount: 60 });
    expect(step.action).toBe("farewell");
  });

  it("reads unknown persisted states as active", () => {
    expect(readClosingState("nonsense")).toBe("active");
    expect(readClosingState("completion_check")).toBe("completion_check");
  });
});

describe("latency accounting", () => {
  const entry = (total: number): TurnLatency => ({
    seq: 1,
    kind: "utterance",
    asr_ms: 100,
    context_ms: 50,
    reasoning_ms: total - 150,
    tts_ms: 0,
    total_ms: total,
    fast_path: false,
  });

  it("summarizes P50/P95/worst from recorded turns", () => {
    const entries = [800, 1200, 2400, 1000].reduce<TurnLatency[]>(
      (acc, ms) => appendLatency(acc, entry(ms)) as TurnLatency[],
      [],
    );
    const stats = summarizeLatency(entries);
    expect(stats["turns"]).toBe(4);
    expect(stats["worst_total_ms"]).toBe(2400);
    expect(stats["p95_total_ms"]).toBe(2400);
    expect(stats["p50_total_ms"]).toBeLessThanOrEqual(1200);
  });
});

function db(tables: Record<string, unknown[]>) {
  const build = (rows: unknown[]) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      ilike: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: rows }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null }),
      insert: () => Promise.resolve({ error: null }),
      then: undefined,
    };
    return chain;
  };
  return { from: (table: string) => build(tables[table] ?? []) };
}

describe("cross-channel relationship memory", () => {
  it("resolves an existing WhatsApp customer and carries their recent thread", async () => {
    const ctx = await hydrateCallerContext(
      db({
        leads: [
          {
            id: "lead-1",
            full_name: "Encik Ryzal",
            phone: "+60111063999",
            stage: "quoted",
            pax: 4,
            package_interest: "Umrah Ramadan 14 hari",
          },
        ],
        conversations: [{ id: "conv-1", channel: "whatsapp" }],
        quotations: [
          { quotation_number: "Q-1001", status: "sent", total: 25000 },
        ],
        messages: [
          { sender: "customer", body: "Saya minat pakej Ramadan", modality: "voice" },
          { sender: "ai", body: "Baik encik, saya hantar sebut harga", modality: "text" },
        ],
      }),
      { agencyId: "agency-1", callerPhone: "60111063999" },
    );

    expect(ctx.leadId).toBe("lead-1");
    expect(ctx.conversationId).toBe("conv-1");
    expect(ctx.knownName).toBe("Encik Ryzal");
    const joined = ctx.promptLines.join("\n");
    expect(joined).toContain("EXISTING customer");
    expect(joined).toContain("Umrah Ramadan 14 hari");
    expect(joined).toContain("Q-1001");
    expect(joined).toContain("pakej Ramadan");
    expect(ctx.facts["known_customer"]).toBe(true);
  });

  it("never fabricates memory for a genuine first contact", async () => {
    const ctx = await hydrateCallerContext(db({ leads: [] }), {
      agencyId: "agency-1",
      callerPhone: "60123456789",
    });
    expect(ctx).toEqual(EMPTY_CALLER_CONTEXT);
    expect(ctx.promptLines).toHaveLength(0);
  });
});
