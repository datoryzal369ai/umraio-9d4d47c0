/**
 * UMRAIO® — QUOTATION ACCEPTANCE → CHECKOUT STATE TRANSITION.
 *
 * Regression: after the QUOTATION CHECK mismatch reply was shown, a plain
 * "Saya setuju" looped back into the same QUOTATION CHECK message instead of
 * advancing the commercial flow. Text and voice-transcribed acceptances must
 * behave identically.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { acceptQuotationInChat } from "../src/lib/quotations/acceptance.server";
import { detectQuotationAcceptance } from "../src/lib/quotations/closing.core";

const AGENCY = "agency-1";
const LEAD = "lead-1";
const CONV = "conv-1";

type Row = Record<string, unknown>;

function makeDb(rows: Row[]) {
  const inserts: Array<{ table: string; payload: Row }> = [];
  const state = rows.map((r) => ({ ...r }));

  function table(name: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "update" = "select";
    let patch: Row = {};

    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      in: (col: string, vals: readonly unknown[]) => {
        filters.push((r) => vals.includes(r[col] as never));
        return api;
      },
      or: (expr: string) => {
        const clauses = expr.split(",").map((c) => {
          const [col, , val] = c.split(".");
          return { col: col!, val: val! };
        });
        filters.push((r) => clauses.some((c) => r[c.col] === c.val));
        return api;
      },
      order: () => api,
      limit: () => api,
      update: (p: Row) => {
        mode = "update";
        patch = p;
        return api;
      },
      insert: (payload: Row) => {
        inserts.push({ table: name, payload });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        const matched = state.filter((r) => filters.every((f) => f(r)));
        if (mode === "update") for (const r of matched) Object.assign(r, patch);
        return Promise.resolve(resolve({ data: matched, error: null }));
      },
    };
    return api;
  }

  return { db: { from: (n: string) => table(n) } as never, inserts, state };
}

const economyRow = (over: Row = {}): Row => ({
  id: "q1",
  agency_id: AGENCY,
  lead_id: LEAD,
  conversation_id: CONV,
  status: "sent",
  quotation_number: "Q-2026-0002",
  total: 29400,
  deposit_amount: 5880,
  number_of_pilgrims: 3,
  package_snapshot: { name: "Umrah Ekonomi 12 Hari" },
  ...over,
});

const baseScope = {
  agencyId: AGENCY,
  leadId: LEAD,
  conversationId: CONV,
  // The customer asked for VIP earlier in the conversation (sticky preference).
  customerMessages: ["Saya nak pakej VIP"],
  catalogueNames: ["Umrah Ekonomi 12 Hari", "Umrah VIP 12 Hari"],
  mismatchDisclosed: true,
};

describe("acceptance → checkout transition", () => {
  for (const text of ["Saya setuju", "Ya, saya setuju", "Teruskan", "Ok, teruskan"]) {
    it(`1-4. "${text}" after a disclosed QUOTATION CHECK advances instead of repeating it`, async () => {
      expect(detectQuotationAcceptance(text, { quotationInContext: true })).toBe(true);
      const { db, inserts, state } = makeDb([economyRow()]);
      const out = await acceptQuotationInChat(db, { ...baseScope, acceptanceMessage: text });
      expect(out.reason).not.toBe("package_mismatch");
      expect(out.accepted).toBe(true);
      expect(out.quotation?.quotationNumber).toBe("Q-2026-0002");
      // 8/9 — no duplicate quotation, the same row transitions in place.
      expect(state).toHaveLength(1);
      expect(state[0]!["id"]).toBe("q1");
      expect(state[0]!["quotation_number"]).toBe("Q-2026-0002");
      expect(state[0]!["status"]).toBe("accepted");
      expect(inserts.some((i) => i.table === "quotations")).toBe(false);
    });
  }

  it("5. a voice-transcribed acceptance takes the same path as text", async () => {
    const transcript = "Saya setuju";
    expect(detectQuotationAcceptance(transcript, { quotationInContext: true })).toBe(
      detectQuotationAcceptance("Saya setuju", { quotationInContext: true }),
    );
    const { db } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, {
      ...baseScope,
      acceptanceMessage: transcript,
    });
    expect(out.accepted).toBe(true);
    expect(out.quotation?.id).toBe("q1");
  });

  it("6. accepted quotation with a deposit exposes the checkout amount", async () => {
    const { db } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, {
      ...baseScope,
      acceptanceMessage: "Saya setuju",
    });
    expect(out.quotation?.depositMyr).toBe(5880);
    expect(out.quotation?.totalMyr).toBe(29400);
  });

  it("7. accepted quotation without a deposit still returns the total for deposit derivation", async () => {
    const { db } = makeDb([economyRow({ deposit_amount: null })]);
    const out = await acceptQuotationInChat(db, {
      ...baseScope,
      acceptanceMessage: "Saya setuju",
    });
    expect(out.accepted).toBe(true);
    expect(out.quotation?.depositMyr).toBeNull();
    expect(out.quotation?.totalMyr).toBe(29400);
    const webhook = readFileSync("src/routes/api/public/whatsapp.ts", "utf8");
    expect(webhook).toContain("resolveDepositMyr");
  });

  it("guard kept: naming a different package in the acceptance turn still refuses", async () => {
    const { db, state } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, {
      ...baseScope,
      acceptanceMessage: "Saya setuju, tapi saya nak VIP",
    });
    expect(out.reason).toBe("package_mismatch");
    expect(state[0]!["status"]).toBe("sent");
  });

  it("guard kept: first SETUJU before disclosure still returns QUOTATION CHECK", async () => {
    const { db } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, {
      ...baseScope,
      mismatchDisclosed: false,
      acceptanceMessage: "Saya setuju",
    });
    expect(out.reason).toBe("package_mismatch");
  });

  it("bare 'ya' only closes when a quotation is on the table", () => {
    expect(detectQuotationAcceptance("Ya")).toBe(false);
    expect(detectQuotationAcceptance("Ya", { quotationInContext: true })).toBe(true);
    expect(detectQuotationAcceptance("Boleh", { quotationInContext: true })).toBe(true);
    expect(detectQuotationAcceptance("Saya pilih yang ini", { quotationInContext: true })).toBe(true);
    expect(detectQuotationAcceptance("Saya mahu pakej ini", { quotationInContext: true })).toBe(true);
    expect(detectQuotationAcceptance("Fikir dulu", { quotationInContext: true })).toBe(false);
  });
});
