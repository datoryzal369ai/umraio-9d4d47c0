import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_QUOTATION_RECOVERY,
  resolveQuotationContinuity,
  type CallQuotationCandidate,
  type QuotationContinuityHistoryTurn,
} from "@/lib/calls/quotation-continuity.core";

const quote = (overrides: Partial<CallQuotationCandidate> = {}): CallQuotationCandidate => ({
  quotationNumber: "Q-2026-1001",
  packageName: "Umrah Disember",
  travelDate: "Disember 2026",
  pax: 4,
  ...overrides,
});

const turn = (role: "customer" | "umraio", text: string): QuotationContinuityHistoryTurn => ({ role, text });

function resolve(
  transcript: string,
  candidates: CallQuotationCandidate[] = [],
  history: QuotationContinuityHistoryTurn[] = [],
) {
  return resolveQuotationContinuity({
    transcript,
    history,
    recognizedCaller: true,
    leadResolved: true,
    conversationLinked: true,
    candidates,
    packageInterest: "Umrah Disember",
    preferredMonth: "Disember 2026",
    pax: 4,
  });
}

describe("authoritative Calling quotation continuity", () => {
  it("matches a caller-supplied quotation number without speaking the stored number", () => {
    const result = resolve("Quotation Q-2026-1001", [quote()]);
    expect(result?.strategy).toBe("reference");
    expect(result?.candidate?.quotationNumber).toBe("Q-2026-1001");
    expect(result?.reply).not.toContain("Q-2026-1001");
    expect(result?.privateDataAuthorized).toBe(false);
  });

  it("does not mistake the word quotation itself for a quotation reference", () => {
    const result = resolve("Saya nak tanya quotation", [quote()]);
    expect(result?.strategy).toBe("single_candidate");
  });

  it("does not require a quotation number", () => {
    const result = resolve("Saya tak ada nombor quotation tu", [quote()]);
    expect(result?.strategy).toBe("single_candidate");
    expect(result?.reply).toMatch(/Tak apa/);
    expect(result?.reply).toMatch(/WhatsApp kita/);
  });

  it("narrows one safely resolvable recent quotation", () => {
    const result = resolve("Saya tak tahu nombor quotation", [quote()]);
    expect(result?.reply).toContain("pakej Umrah Disember");
    expect(result?.reply).not.toMatch(/Q-2026|RM|deposit|https?:/i);
  });

  it("keeps a tenant-bound lead candidate usable when no conversation row exists", () => {
    const result = resolveQuotationContinuity({
      transcript: "Saya tak ada nombor quotation",
      history: [],
      recognizedCaller: true,
      leadResolved: true,
      conversationLinked: false,
      candidates: [quote()],
    });
    expect(result?.strategy).toBe("single_candidate");
  });

  it("distinguishes multiple candidates with one useful question", () => {
    const result = resolve("Tak ada nombor quotation", [
      quote(),
      quote({ quotationNumber: "Q-2026-1002", packageName: "Umrah Ramadan" }),
    ]);
    expect(result?.strategy).toBe("multiple_candidates");
    expect(result?.reply).toMatch(/Umrah Disember.*atau.*Umrah Ramadan/);
    expect(result?.reply.match(/\?/g)).toHaveLength(1);
  });

  it("asks for a real matching clue when no quotation matches", () => {
    const result = resolveQuotationContinuity({
      transcript: "Saya tak tahu nombor quotation",
      history: [],
      recognizedCaller: false,
      leadResolved: false,
      conversationLinked: false,
      candidates: [],
    });
    expect(result?.reply).toMatch(/nama pakej atau bulan perjalanan/);
    expect(result?.reply).not.toMatch(/jumpa.*rekod/i);
  });

  it("recognition never authorizes private quotation disclosure", () => {
    const withoutNumber = resolve("Saya tak ada nombor quotation", [quote()]);
    const withNumber = resolve("Quotation Q-2026-1001", [quote()]);
    expect(withoutNumber?.privateDataAuthorized).toBe(false);
    expect(withNumber?.privateDataAuthorized).toBe(false);
    expect(withoutNumber?.reply).not.toMatch(/Q-2026|RM|deposit|https?:/i);
  });

  it("never emits the rejected repetitive recovery", () => {
    const cases = [
      resolve("Tak ada nombor quotation", [quote()]),
      resolve("Tak ada nombor quotation", []),
      resolve("Quotation Q-9999", [quote()]),
    ];
    for (const result of cases) expect(result?.reply).not.toMatch(FORBIDDEN_QUOTATION_RECOVERY);
  });

  it("changes strategy on a second failed attempt", () => {
    const first = resolve("Tak ada nombor quotation", [quote()]);
    const second = resolve("Saya memang tak tahu", [quote()], [turn("umraio", first!.reply)]);
    expect(second?.reply).not.toBe(first?.reply);
    expect(second?.reply).toMatch(/bulan perjalanan atau jumlah jemaah/);
  });

  it("preserves unrelated required-next-step turns for existing cognition", () => {
    expect(resolve("Saya nak bayar deposit sekarang")).toBeNull();
    expect(resolve("Boleh staff call saya balik?")).toBeNull();
  });

  it("escalates after two failed recoveries instead of looping", () => {
    const history = [
      turn("umraio", "Tak apa. Yang pakej Umrah Disember itu, betul?"),
      turn("customer", "Saya tak pasti"),
      turn("umraio", "Kita cuba cara lain—bulan perjalanan atau jumlah jemaah berapa?"),
    ];
    const result = resolve("Saya tak tahu juga", [quote()], history);
    expect(result?.strategy).toBe("handoff");
    expect(result?.reply).toMatch(/staf.*WhatsApp/i);
  });
});
