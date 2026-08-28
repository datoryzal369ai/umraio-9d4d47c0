/**
 * UMRAIO® — RED-3 PACKAGE IDENTITY ACCEPTANCE GUARD.
 *
 * A "SETUJU" must never accept a quotation for a package the customer
 * explicitly did NOT ask for. Reuses the RED-2 identity logic; nothing about
 * pricing, numbering, delivery or the one-live-quotation rule changes.
 */
import { describe, expect, it } from "vitest";

import { acceptQuotationInChat } from "../src/lib/quotations/acceptance.server";
import { packageMismatchReply } from "../src/lib/quotations/package-identity.core";

const AGENCY = "agency-1";
const OTHER_AGENCY = "agency-2";
const LEAD = "lead-1";
const OTHER_LEAD = "lead-2";
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
  status: "deposit_pending",
  quotation_number: "Q-2026-0002",
  total: 29400,
  deposit_amount: null,
  number_of_pilgrims: 3,
  package_snapshot: { name: "Umrah Ekonomi 12 Hari" },
  ...over,
});

const scope = { agencyId: AGENCY, leadId: LEAD, conversationId: CONV };

describe("RED-3 — package identity acceptance guard", () => {
  it("A. VIP requested + live Economy quotation + SETUJU → refused, no mutation, no events", async () => {
    const { db, inserts, state } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, {
      ...scope,
      customerMessages: ["Saya nak quotation VIP untuk 3 orang.", "SETUJU"],
      catalogueNames: ["Umrah Ekonomi 12 Hari", "Umrah VIP 14 Hari"],
    });

    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("package_mismatch");
    expect(state[0]!["status"]).toBe("deposit_pending");
    expect(state[0]!["accepted_at"]).toBeUndefined();
    expect(inserts.filter((i) => i.table === "conversion_events")).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "activity_log")).toHaveLength(0);

    const reply = packageMismatchReply(out.mismatch!.card, out.mismatch!.requested);
    expect(reply).toContain("*QUOTATION CHECK*");
    expect(reply).toContain("Umrah Ekonomi 12 Hari");
    expect(reply).toContain("Q-2026-0002");
    expect(reply).toContain("RM29,400");
    expect(reply).toMatch(/bukan pakej \*Umrah VIP 14 Hari\*|bukan pakej \*VIP\*/);
    expect(reply).not.toMatch(/staf/i);
  });

  it("B. generic SETUJU + live Economy quotation → accepted exactly once", async () => {
    const { db, inserts, state } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, {
      ...scope,
      customerMessages: ["Boleh bagi quotation?", "SETUJU"],
      catalogueNames: ["Umrah Ekonomi 12 Hari", "Umrah VIP 14 Hari"],
    });

    expect(out.accepted).toBe(true);
    expect(out.reason).toBe("accepted");
    expect(state[0]!["status"]).toBe("accepted");
    expect(inserts.filter((i) => i.table === "conversion_events")).toHaveLength(1);
    expect(inserts.filter((i) => i.table === "activity_log")).toHaveLength(1);
  });

  it("B2. no context supplied at all preserves legacy acceptance behaviour", async () => {
    const { db, state } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, scope);
    expect(out.accepted).toBe(true);
    expect(state[0]!["status"]).toBe("accepted");
  });

  it("C. VIP requested + VIP quotation + SETUJU → accepted", async () => {
    const { db, inserts, state } = makeDb([
      economyRow({ package_snapshot: { name: "Umrah VIP 14 Hari" }, quotation_number: "Q-2026-0009" }),
    ]);
    const out = await acceptQuotationInChat(db, {
      ...scope,
      customerMessages: ["Saya nak quotation VIP untuk 3 orang.", "SETUJU"],
      catalogueNames: ["Umrah Ekonomi 12 Hari", "Umrah VIP 14 Hari"],
    });

    expect(out.accepted).toBe(true);
    expect(state[0]!["status"]).toBe("accepted");
    expect(inserts.filter((i) => i.table === "conversion_events")).toHaveLength(1);
  });

  it("D. replayed SETUJU on an already accepted quotation → no duplicate events or mutation", async () => {
    const { db, inserts } = makeDb([economyRow()]);
    const ctx = {
      ...scope,
      customerMessages: ["Boleh bagi quotation?", "SETUJU"],
      catalogueNames: ["Umrah Ekonomi 12 Hari"],
    };
    expect((await acceptQuotationInChat(db, ctx)).accepted).toBe(true);
    const second = await acceptQuotationInChat(db, ctx);
    expect(second.accepted).toBe(false);
    expect(inserts.filter((i) => i.table === "conversion_events")).toHaveLength(1);
    expect(inserts.filter((i) => i.table === "activity_log")).toHaveLength(1);
  });

  it("E. mismatch never accepts a different quotation of the same lead", async () => {
    const { db, inserts, state } = makeDb([
      economyRow(),
      economyRow({ id: "q2", quotation_number: "Q-2026-0003", conversation_id: null }),
    ]);
    const out = await acceptQuotationInChat(db, {
      ...scope,
      customerMessages: ["Saya nak pakej VIP"],
    });
    expect(out.reason).toBe("package_mismatch");
    expect(state.every((r) => r["status"] === "deposit_pending")).toBe(true);
    expect(inserts).toHaveLength(0);
  });

  it("F. tenant + lead scoping is preserved under the guard", async () => {
    const cross = makeDb([economyRow({ agency_id: OTHER_AGENCY })]);
    const outCross = await acceptQuotationInChat(cross.db, {
      ...scope,
      customerMessages: ["Saya nak pakej VIP"],
    });
    expect(outCross.accepted).toBe(false);
    expect(outCross.reason).toBe("no_candidate");
    expect(cross.state[0]!["status"]).toBe("deposit_pending");

    const otherLead = makeDb([economyRow({ lead_id: OTHER_LEAD, conversation_id: null })]);
    const outLead = await acceptQuotationInChat(otherLead.db, {
      agencyId: AGENCY,
      leadId: LEAD,
      conversationId: CONV,
      customerMessages: ["SETUJU"],
    });
    expect(outLead.accepted).toBe(false);
    expect(otherLead.state[0]!["status"]).toBe("deposit_pending");
  });

  it("G. an explicit preference stays sticky across later generic turns", async () => {
    const { db, state } = makeDb([economyRow()]);
    const out = await acceptQuotationInChat(db, {
      ...scope,
      customerMessages: ["Saya nak quotation VIP untuk 3 orang.", "Mana quotation?", "SETUJU"],
    });
    expect(out.reason).toBe("package_mismatch");
    expect(state[0]!["status"]).toBe("deposit_pending");
  });
});
