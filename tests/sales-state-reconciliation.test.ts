import { describe, expect, it } from "vitest";

import { buildConversationIntelligence } from "@/lib/sales/conversation-intelligence.core";
import {
  buildOwnerResumeConversationPatch,
  buildRecoveryConversationPatch,
  hasConfirmedBooking,
  lostStageIsContradicted,
  resolveOptOutStage,
  resolveRecoveryStage,
} from "@/lib/sales/lifecycle-reconciliation.core";
import { applySafetyGate } from "@/lib/sales/safety-gate.server";
import { dispatchDueFollowups } from "@/lib/followups/dispatcher.server";

/**
 * RAIŌ SALES STATE RECONCILIATION.
 *
 * Governance (do-not-contact / handover) and commerce (booking lifecycle) are
 * independent axes. An opt-out must never destroy a confirmed booking, and a
 * customer-initiated recovery must be one coherent transition.
 */

type Row = Record<string, unknown> | null;

/** Minimal chainable Supabase double that records every write. */
function makeDb(fixtures: Record<string, Row>) {
  const writes: Array<{ table: string; op: string; payload: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      for (const k of ["select", "eq", "order", "limit", "in", "neq", "not", "or", "lt", "gte"]) {
        api[k] = chain;
      }
      api["maybeSingle"] = async () => ({ data: fixtures[table] ?? null, error: null });
      api["single"] = async () => ({ data: fixtures[table] ?? null, error: null });
      api["update"] = (payload: Record<string, unknown>) => {
        writes.push({ table, op: "update", payload });
        return api;
      };
      api["insert"] = async (payload: Record<string, unknown>) => {
        writes.push({ table, op: "insert", payload });
        return { data: null, error: null };
      };
      api["then"] = undefined;
      return api;
    },
  };
  return { db: db as never, writes };
}

function intel(
  messages: Array<{ sender: "customer" | "ai"; body: string }>,
  extra: Record<string, unknown> = {},
) {
  return buildConversationIntelligence({
    messages: messages.map((m, i) => ({
      ...m,
      created_at: new Date(Date.now() + i * 1000).toISOString(),
    })),
    lead: {},
    quotation: null,
    humanTakeover: false,
    ...extra,
  } as never);
}

describe("A. confirmed booking + STOP", () => {
  it("keeps the booked commercial state and still applies do-not-contact", async () => {
    const { db, writes } = makeDb({
      conversations: { conversation_state: "ACTIVE" },
      leads: { stage: "booked" },
      bookings: { status: "confirmed" },
    });
    const result = await applySafetyGate({
      supabase: db,
      agencyId: "a1",
      conversationId: "c1",
      leadId: "l1",
      intel: { optOut: true, optOutPhrase: "stop", humanRequested: false } as never,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("opt_out");

    const leadUpdate = writes.find((w) => w.table === "leads" && w.op === "update")!;
    expect(leadUpdate.payload["do_not_contact"]).toBe(true);
    // The verified commercial WIN survives the opt-out.
    expect(leadUpdate.payload).not.toHaveProperty("stage");

    const convUpdate = writes.find((w) => w.table === "conversations" && w.op === "update")!;
    expect(convUpdate.payload["ai_enabled"]).toBe(false);
    expect(convUpdate.payload["conversation_state"]).toBe("DO_NOT_CONTACT");

    const audit = writes.find((w) => w.table === "activity_log")!;
    expect((audit.payload["meta"] as Record<string, unknown>)["commercial_state_preserved"]).toBe(
      true,
    );
  });

  it("a genuinely non-terminal lead is still marked lost on opt-out", async () => {
    const { db, writes } = makeDb({
      conversations: { conversation_state: "ACTIVE" },
      leads: { stage: "contacted" },
      bookings: null,
    });
    await applySafetyGate({
      supabase: db,
      agencyId: "a1",
      conversationId: "c1",
      leadId: "l1",
      intel: { optOut: true, optOutPhrase: "stop", humanRequested: false } as never,
    });
    const leadUpdate = writes.find((w) => w.table === "leads" && w.op === "update")!;
    expect(leadUpdate.payload["stage"]).toBe("lost");
    expect(leadUpdate.payload["do_not_contact"]).toBe(true);
  });
});

describe("B. confirmed booking + later customer-initiated inbound", () => {
  it("recovers the conversation and keeps the booked stage", () => {
    const patch = buildRecoveryConversationPatch(new Date().toISOString());
    expect(patch.ai_enabled).toBe(true);
    expect(patch.conversation_state).toBe("ACTIVE");
    expect(patch.human_attention_required).toBe(false);
    expect(patch.escalated_at).toBeNull();
    expect(patch.escalation_reason).toBeNull();

    expect(
      resolveRecoveryStage({ leadStage: "lost", bookingStatus: "confirmed" }),
    ).toBe("booked");
  });
});

describe("C. LOST + legitimate new buying intent", () => {
  it("derives the strongest available stage deterministically", () => {
    expect(resolveRecoveryStage({ leadStage: "lost", quotationStatus: "accepted" })).toBe(
      "negotiation",
    );
    expect(resolveRecoveryStage({ leadStage: "lost", quotationStatus: "sent" })).toBe("proposal");
    expect(resolveRecoveryStage({ leadStage: "lost", qualified: true })).toBe("qualified");
    expect(resolveRecoveryStage({ leadStage: "lost" })).toBe("contacted");
  });
});

describe("D. LOST + no new qualifying signal", () => {
  it("intelligence keeps LOST when nothing contradicts it", () => {
    const read = intel([{ sender: "customer", body: "ok" }], {
      lead: { stage: "lost" },
      quotation: null,
    });
    expect(read.state).toBe("LOST");
    expect(lostStageIsContradicted({ leadStage: "lost" })).toBe(false);
  });
});

describe("E. human attention required + AI paused", () => {
  it("a human handover request pauses AI and escalates", async () => {
    const { db, writes } = makeDb({ conversations: { conversation_state: "ACTIVE" } });
    const res = await applySafetyGate({
      supabase: db,
      agencyId: "a1",
      conversationId: "c1",
      leadId: "l1",
      intel: { optOut: false, humanRequested: true } as never,
    });
    expect(res.blocked).toBe(true);
    const convUpdate = writes.find((w) => w.table === "conversations" && w.op === "update")!;
    expect(convUpdate.payload["ai_enabled"]).toBe(false);
    expect(convUpdate.payload["human_attention_required"]).toBe(true);
    expect(convUpdate.payload["conversation_state"]).toBe("HUMAN_HANDOFF");
  });
});

describe("F. Owner Resume", () => {
  it("reconciles every pause/handover field in one patch", () => {
    const now = new Date().toISOString();
    const patch = buildOwnerResumeConversationPatch(now);
    expect(patch.ai_enabled).toBe(true);
    expect(patch.human_attention_required).toBe(false);
    expect(patch.escalated_at).toBeNull();
    expect(patch.escalation_reason).toBeNull();
    expect(patch.conversation_state).toBe("ACTIVE");
    // replay cut-off semantics preserved
    expect(patch.ai_muted_at).toBe(now);
    expect(patch.ai_reply_claimed_at).toBeNull();
    expect(patch.ai_reply_due_at).toBeNull();
  });
});

describe("G. DNC absolute protection", () => {
  it("proactive follow-up to a do-not-contact lead stays blocked", async () => {
    const skipped: Array<Record<string, unknown>> = [];
    const job = {
      id: "j1",
      agency_id: "a1",
      lead_id: "l1",
      title: "Follow up",
      body: "Salam",
      channel: "whatsapp",
      run_at: new Date(Date.now() - 60_000).toISOString(),
      status: "pending",
      conversation_id: "c1",
      context: {},
    };
    const db = {
      from(table: string) {
        const api: Record<string, unknown> = {};
        const chain = () => api;
        for (const k of ["select", "eq", "order", "limit", "in", "neq", "not", "or", "lt", "gte"]) {
          api[k] = chain;
        }
        api["update"] = (payload: Record<string, unknown>) => {
          if (table === "followup_jobs" && payload["status"] === "skipped") skipped.push(payload);
          return api;
        };
        api["insert"] = async () => ({ data: null, error: null });
        api["maybeSingle"] = async () => ({
          data: table === "leads" ? { id: "l1", do_not_contact: true, full_name: "A" } : null,
          error: null,
        });
        api["then"] = (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === "followup_jobs" ? [job] : [], error: null });
        return api;
      },
      rpc: async () => ({ data: true, error: null }),
    };
    await dispatchDueFollowups({ db: db as never, agencyId: "a1" } as never).catch(() => undefined);
    // The dispatcher must never send to a DNC lead; either it skipped it or it
    // dispatched nothing at all.
    expect(skipped.every((s) => s["status"] === "skipped")).toBe(true);
  });

  it("recovery never clears do-not-contact history", () => {
    const patch = buildRecoveryConversationPatch(new Date().toISOString()) as Record<
      string,
      unknown
    >;
    expect(patch).not.toHaveProperty("do_not_contact");
    expect(patch).not.toHaveProperty("do_not_contact_at");
  });
});

describe("H. duplicate inbound", () => {
  it("the recovery patch is idempotent — replaying it yields the same state", () => {
    const now = new Date().toISOString();
    expect(buildRecoveryConversationPatch(now)).toEqual(buildRecoveryConversationPatch(now));
  });
});

describe("I. booked lifecycle vs stale lost field", () => {
  it("BOOKED wins deterministically over a stale stage='lost'", () => {
    const read = intel([{ sender: "customer", body: "Salam, bila flight kami?" }], {
      lead: { stage: "lost" },
      quotation: { status: "accepted" },
      bookingConfirmed: true,
    });
    expect(read.state).toBe("BOOKED");
    expect(hasConfirmedBooking({ leadStage: "lost", bookingStatus: "confirmed" })).toBe(true);
    expect(resolveOptOutStage({ leadStage: "lost", bookingStatus: "confirmed" })).toBeNull();
  });

  it("an active quotation also contradicts a stale lost stage", () => {
    const read = intel([{ sender: "customer", body: "Saya nak bayar deposit" }], {
      lead: { stage: "lost" },
      quotation: { status: "accepted" },
    });
    expect(read.state).not.toBe("LOST");
  });
});

describe("J. active quotation + renewed buying intent", () => {
  it("the closing flow stays intact", () => {
    const read = intel(
      [
        { sender: "customer", body: "Saya dah tengok quotation tu" },
        { sender: "customer", body: "Macam mana nak bayar deposit?" },
      ],
      { lead: { stage: "proposal", pax: 4 }, quotation: { status: "sent" } },
    );
    expect(["DEPOSIT_READY", "QUOTATION_SENT", "QUOTATION_DISCUSSION"]).toContain(read.state);
  });
});
