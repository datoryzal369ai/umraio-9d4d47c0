import { describe, expect, it } from "vitest";

import { buildConversationIntelligence } from "@/lib/sales/conversation-intelligence.core";
import { dispatchDueFollowups } from "@/lib/followups/dispatcher.server";

/**
 * DNC / CURRENT-TURN SAFETY.
 *
 * 1. Historical do-not-contact never blocks a NEW customer-initiated turn.
 * 2. A current-turn STOP blocks the reply and re-applies do-not-contact.
 * 3. Proactive outbound to a do-not-contact lead stays blocked.
 */

function intel(messages: Array<{ sender: "customer" | "ai"; body: string }>, doNotContact = false) {
  return buildConversationIntelligence({
    messages: messages.map((m, i) => ({
      ...m,
      created_at: new Date(Date.now() + i * 1000).toISOString(),
    })),
    lead: { doNotContact },
  } as never);
}

describe("DNC current-turn rule", () => {
  it("historical STOP does not block a new inbound turn", () => {
    const read = intel([
      { sender: "customer", body: "jangan whatsapp saya lagi" },
      { sender: "ai", body: "Baik, saya hentikan mesej automatik." },
      { sender: "customer", body: "Assalamualaikum, saya nak tanya pakej Umrah bulan Dis" },
    ]);
    expect(read.optOut).toBe(false);
    expect(read.state).not.toBe("DO_NOT_CONTACT");
  });

  it("historical do_not_contact lead flag does not block a new inbound turn", () => {
    const read = intel(
      [{ sender: "customer", body: "Saya nak tanya harga pakej untuk 4 orang" }],
      true,
    );
    expect(read.optOut).toBe(false);
    expect(read.state).not.toBe("DO_NOT_CONTACT");
  });

  it("current-turn STOP opts out immediately", () => {
    const read = intel([
      { sender: "customer", body: "Saya nak tanya pakej" },
      { sender: "customer", body: "stop contact saya" },
    ]);
    expect(read.optOut).toBe(true);
    expect(read.state).toBe("DO_NOT_CONTACT");
  });

  it("current-turn unsubscribe opts out even after a friendly history", () => {
    const read = intel([
      { sender: "customer", body: "Menarik juga pakej ni" },
      { sender: "customer", body: "unsubscribe" },
    ]);
    expect(read.optOut).toBe(true);
  });

  it("voice transcripts follow the same current-turn rule", () => {
    // A transcribed voice note enters the same text pipeline.
    const past = intel([
      { sender: "customer", body: "jangan hantar promosi lagi" },
      { sender: "customer", body: "Saya nak tahu pakej September ada lagi tak" },
    ]);
    expect(past.optOut).toBe(false);
    const now = intel([{ sender: "customer", body: "jangan hubungi saya lagi" }]);
    expect(now.optOut).toBe(true);
  });

  it("proactive follow-up to a do-not-contact lead stays blocked", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      from(table: string) {
        const api: Record<string, unknown> = {};
        // The body-less cleanup query uses .or("body.is.null,body.eq.") while the
        // dispatch query filters body via .not/.neq. Track which is which so the
        // two queries do not return the same fixture and double-count skips.
        let isBodyLessCleanup = false;
        const chain = new Proxy(api, {
          get(_t, prop) {
            if (prop === "then") return undefined;
            if (prop === "or")
              return (..._a: unknown[]) => {
                isBodyLessCleanup = true;
                return chain;
              };
            if (prop === "update")
              return (patch: Record<string, unknown>) => {
                if (table === "followup_jobs") updates.push(patch);
                return chain;
              };
            if (prop === "maybeSingle")
              return async () => {
                if (table === "agencies") return { data: { timezone: "Asia/Kuala_Lumpur" } };
                if (table === "leads")
                  return { data: { id: "lead-1", phone: "60123", stage: "new", do_not_contact: true } };
                if (table === "whatsapp_configs")
                  return { data: { phone_number_id: "p", access_token: "t", is_connected: true } };
                return { data: null };
              };
            if (prop === "limit")
              return async (..._a: unknown[]) => ({
                // Cleanup query: fixture job has a body, so nothing body-less.
                // Dispatch query: the single body-bearing fixture job.
                data: isBodyLessCleanup
                  ? []
                  : [
                  {
                    id: "job-1",
                    lead_id: "lead-1",
                    conversation_id: null,
                    quotation_id: null,
                    title: "Nudge",
                    body: "Salam, masih berminat?",
                    run_at: new Date().toISOString(),
                    channel: "whatsapp",
                    created_at: new Date().toISOString(),
                    attempts: 0,
                  },
                ],
              });
            return () => chain;
          },
        });
        return chain;
      },
      rpc: async () => ({ data: true, error: null }),
    } as never;

    // Force the send window open regardless of wall-clock time.
    const realDtf = Intl.DateTimeFormat;
    // @ts-expect-error test stub
    Intl.DateTimeFormat = function () {
      return { format: () => "12" };
    };
    try {
      const result = await dispatchDueFollowups(db, "agency-1", 5);
      expect(result.sent).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.details[0]?.reason).toMatch(/no further contact/i);
    } finally {
      Intl.DateTimeFormat = realDtf;
    }
  });
});
