import { describe, expect, it } from "vitest";

import {
  ACCEPTABLE_QUOTATION_STATUSES,
  detectQuotationAcceptance,
  quotationAcceptedReply,
  selectAcceptanceCandidate,
} from "../src/lib/quotations/closing.core";
import { acceptQuotationInChat } from "../src/lib/quotations/acceptance.server";

const AGENCY = "agency-1";
const OTHER_AGENCY = "agency-2";
const LEAD = "lead-1";
const OTHER_LEAD = "lead-2";
const CONV = "conv-1";

type Row = Record<string, unknown>;

/** Minimal supabase double that honours the filters the helper applies. */
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

const baseRow = (over: Row): Row => ({
  id: "q1",
  agency_id: AGENCY,
  lead_id: LEAD,
  conversation_id: null,
  status: "sent",
  quotation_number: "Q-2026-0002",
  total: 29400,
  deposit_amount: null,
  ...over,
});

describe("RED-1 — WhatsApp quotation acceptance", () => {
  it("A. accepts the real production shape (deposit_pending + conversation_id)", async () => {
    const { db, inserts, state } = makeDb([
      baseRow({ status: "deposit_pending", conversation_id: CONV }),
    ]);
    const out = await acceptQuotationInChat(db, {
      agencyId: AGENCY,
      leadId: LEAD,
      conversationId: CONV,
    });
    expect(detectQuotationAcceptance("SETUJU")).toBe(true);
    expect(out.accepted).toBe(true);
    expect(out.quotation?.quotationNumber).toBe("Q-2026-0002");
    expect(state[0]!["status"]).toBe("accepted");
    const events = inserts.filter((i) => i.table === "conversion_events");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload["stage"]).toBe("quotation_accepted");
    expect(inserts.filter((i) => i.table === "activity_log")).toHaveLength(1);

    const reply = quotationAcceptedReply({
      quotationNumber: out.quotation!.quotationNumber,
      totalMyr: out.quotation!.totalMyr,
      depositMyr: out.quotation!.depositMyr,
    });
    expect(reply).toContain("QUOTATION DITERIMA");
    expect(reply).toContain("Q-2026-0002");
    expect(reply).toContain("RM29,400");
    expect(reply).not.toMatch(/staf/i);
  });

  it("B. accepts a viewed quotation with a NULL conversation_id", async () => {
    const { db, state } = makeDb([baseRow({ status: "viewed", conversation_id: null })]);
    const out = await acceptQuotationInChat(db, {
      agencyId: AGENCY,
      leadId: LEAD,
      conversationId: CONV,
    });
    expect(out.accepted).toBe(true);
    expect(state[0]!["status"]).toBe("accepted");
  });

  it("C. accepts a ready quotation with a NULL conversation_id", async () => {
    const { db } = makeDb([baseRow({ status: "ready", conversation_id: null })]);
    expect((await acceptQuotationInChat(db, { agencyId: AGENCY, leadId: LEAD, conversationId: CONV })).accepted).toBe(true);
  });

  it("D. a repeated SETUJU produces no second acceptance or conversion event", async () => {
    const { db, inserts } = makeDb([baseRow({ status: "deposit_pending", conversation_id: CONV })]);
    const scope = { agencyId: AGENCY, leadId: LEAD, conversationId: CONV };
    expect((await acceptQuotationInChat(db, scope)).accepted).toBe(true);
    const second = await acceptQuotationInChat(db, scope);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("no_candidate");
    expect(inserts.filter((i) => i.table === "conversion_events")).toHaveLength(1);
  });

  it("E. never accepts another agency's quotation", async () => {
    const { db, state } = makeDb([
      baseRow({ agency_id: OTHER_AGENCY, status: "sent", conversation_id: CONV }),
    ]);
    const out = await acceptQuotationInChat(db, {
      agencyId: AGENCY,
      leadId: LEAD,
      conversationId: CONV,
    });
    expect(out.accepted).toBe(false);
    expect(state[0]!["status"]).toBe("sent");
  });

  it("F. never accepts an unrelated lead's quotation", () => {
    const candidate = selectAcceptanceCandidate(
      [baseRow({ lead_id: OTHER_LEAD, conversation_id: "conv-other" }) as never],
      { agencyId: AGENCY, leadId: LEAD, conversationId: CONV },
    );
    expect(candidate).toBeNull();
  });

  it("G. never accepts cancelled/rejected/expired quotations", async () => {
    for (const status of ["cancelled", "rejected", "expired", "booked"]) {
      const { db, state } = makeDb([baseRow({ status, conversation_id: CONV })]);
      const out = await acceptQuotationInChat(db, {
        agencyId: AGENCY,
        leadId: LEAD,
        conversationId: CONV,
      });
      expect(out.accepted).toBe(false);
      expect(state[0]!["status"]).toBe(status);
    }
    expect(ACCEPTABLE_QUOTATION_STATUSES).toEqual([
      "ready",
      "sent",
      "viewed",
      "discussing",
      "deposit_pending",
    ]);
  });

  it("prefers the conversation-matched quotation over an older lead-only one", () => {
    const picked = selectAcceptanceCandidate(
      [
        baseRow({ id: "q-lead", conversation_id: null }) as never,
        baseRow({ id: "q-conv", conversation_id: CONV }) as never,
      ],
      { agencyId: AGENCY, leadId: LEAD, conversationId: CONV },
    );
    expect(picked?.id).toBe("q-conv");
  });

  it("states the truth when no deposit is configured", () => {
    const reply = quotationAcceptedReply({
      quotationNumber: "Q-2026-0002",
      totalMyr: 29400,
      depositMyr: null,
    });
    expect(reply).toContain("Deposit belum ditetapkan");
    expect(reply).not.toMatch(/staf|akan hubungi/i);
  });

  it("the webhook uses the tenant+lead acceptance helper", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const webhook = fs.readFileSync("src/routes/api/public/whatsapp.ts", "utf8");
    expect(webhook).toContain("acceptQuotationInChat");
    expect(webhook).toContain("detectQuotationAcceptance(latestBody)");
    expect(webhook).not.toContain('.in("status", ["sent", "viewed"])');
  });
});
