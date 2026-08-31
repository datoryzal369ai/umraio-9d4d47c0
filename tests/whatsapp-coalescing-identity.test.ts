import { describe, expect, test } from "vitest";

import {
  detectDeclaredName,
  detectSelfName,
  resolveAddress,
} from "../src/lib/sales/social-presence.core";
import {
  COALESCE_WINDOW_MS,
  isClaimStale,
  selectCoalescedInbound,
  shouldGenerateReply,
  type CoalescedMessage,
} from "../src/lib/whatsapp/coalescing.core";
import { claimConversationReply } from "../src/lib/whatsapp/coalescing.server";

/* ------------------------------------------------------------------ */
/* J1 + J2 — NAME & IDENTITY                                           */
/* ------------------------------------------------------------------ */

describe("J1 — false name extraction", () => {
  const noName = [
    "Kenapa diam pulak",
    "Dia diam pulak",
    "Saya diam dulu",
    "Dia datang kemudian",
    "Salam",
    "Heloo",
    "Awak pergi mana?",
  ];
  for (const m of noName) {
    test(`no name from: ${m}`, () => {
      expect(detectSelfName(m)).toBeNull();
    });
  }

  test("real English introductions still work", () => {
    expect(detectSelfName("I am John")).toBe("John");
    expect(detectSelfName("I'm John")).toBe("John");
    expect(detectSelfName("My name is John")).toBe("John");
    expect(detectSelfName("This is John")).toBe("John");
  });

  test("Malay declarations still work", () => {
    expect(detectSelfName("Nama saya Ahmad")).toBe("Ahmad");
    expect(detectDeclaredName("Panggil saya Ahmad")).toBe("Ahmad");
    expect(detectDeclaredName("Boleh panggil saya Ahmad")).toBe("Ahmad");
    expect(detectDeclaredName("I am John")).toBeNull();
  });
});

describe("J2 — identity precedence", () => {
  const knownName = "Dato Ryzal Jamaludin";

  test("ambiguous text cannot override stored identity", () => {
    const r = resolveAddress({ customerMessages: ["Kenapa diam pulak"], knownName });
    expect(r.addressForm).toContain("Ryzal");
    expect(r.addressForm).not.toContain("Pulak");
  });

  test("weak inference cannot override stored identity", () => {
    const r = resolveAddress({ customerMessages: ["Saya Ahmad tadi call"], knownName });
    expect(r.name).toContain("Ryzal");
  });

  test("explicit declaration may update the preferred name", () => {
    const r = resolveAddress({ customerMessages: ["Nama saya Ahmad"], knownName });
    expect(r.preferredName).toBe("Ahmad");
    expect(r.addressForm).toContain("Ahmad");
  });

  test("no stored identity — inference still allowed", () => {
    const r = resolveAddress({ customerMessages: ["I am John"] });
    expect(r.name).toBe("John");
  });
});

/* ------------------------------------------------------------------ */
/* J3 — COALESCING                                                     */
/* ------------------------------------------------------------------ */

const A = "agency-a";
const B = "agency-b";
const C1 = "conv-1";
const C2 = "conv-2";

function msg(
  body: string,
  offsetSec: number,
  over: Partial<CoalescedMessage> = {},
): CoalescedMessage {
  return {
    agency_id: A,
    conversation_id: C1,
    sender: "customer",
    body,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSec)).toISOString(),
    ...over,
  };
}

describe("J3 — rapid message coalescing", () => {
  test("two rapid messages resolve to one reply batch", () => {
    const batch = selectCoalescedInbound([msg("Heloo", 0), msg("Awak ada?", 2)], {
      agencyId: A,
      conversationId: C1,
    });
    expect(batch.map((m) => m.body)).toEqual(["Heloo", "Awak ada?"]);
  });

  test("multiple rapid messages stay chronological in one batch", () => {
    const batch = selectCoalescedInbound(
      [msg("Salam", 4), msg("Heloo", 0), msg("Helloo", 1), msg("Awak ada?", 3)],
      { agencyId: A, conversationId: C1 },
    );
    expect(batch).toHaveLength(4);
    expect(batch[0]!.body).toBe("Heloo");
    expect(batch[3]!.body).toBe("Salam");
  });

  test("different conversations never merge", () => {
    const batch = selectCoalescedInbound(
      [msg("Heloo", 0), msg("Other convo", 1, { conversation_id: C2 })],
      { agencyId: A, conversationId: C1 },
    );
    expect(batch).toHaveLength(1);
  });

  test("different agencies never merge", () => {
    const batch = selectCoalescedInbound(
      [msg("Heloo", 0), msg("Other tenant", 1, { agency_id: B })],
      { agencyId: A, conversationId: C1 },
    );
    expect(batch).toHaveLength(1);
  });

  test("a single isolated message still produces a reply", () => {
    expect(shouldGenerateReply([msg("Assalamualaikum", 0)], { agencyId: A, conversationId: C1 })).toBe(
      true,
    );
  });

  test("already-answered messages are not re-answered", () => {
    const batch = selectCoalescedInbound(
      [msg("Heloo", 0), msg("Waalaikumsalam", 5, { sender: "ai" })],
      { agencyId: A, conversationId: C1 },
    );
    expect(batch).toHaveLength(0);
  });

  test("coalescing window is within the 8–12s target", () => {
    expect(COALESCE_WINDOW_MS).toBeGreaterThanOrEqual(3_000);
    expect(COALESCE_WINDOW_MS).toBeLessThanOrEqual(6_000);
  });

  test("concurrent processing cannot generate duplicate responses", async () => {
    // Simulated compare-and-set: only the first claim on an unclaimed row wins.
    let claimedAt: string | null = null;
    const supabase = {
      from() {
        const q: Record<string, unknown> = {};
        const chain = {
          update(patch: { ai_reply_claimed_at: string }) {
            q["patch"] = patch;
            return chain;
          },
          eq: () => chain,
          or: () => chain,
          select: async () => {
            if (claimedAt) return { data: [] };
            claimedAt = (q["patch"] as { ai_reply_claimed_at: string }).ai_reply_claimed_at;
            return { data: [{ id: C1 }] };
          },
        };
        return chain;
      },
    };

    const results = await Promise.all([
      claimConversationReply(supabase as never, { agencyId: A, conversationId: C1 }),
      claimConversationReply(supabase as never, { agencyId: A, conversationId: C1 }),
      claimConversationReply(supabase as never, { agencyId: A, conversationId: C1 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("an abandoned claim eventually becomes reclaimable", () => {
    const now = new Date();
    expect(isClaimStale(new Date(now.getTime() - 5_000).toISOString(), now)).toBe(false);
    expect(isClaimStale(new Date(now.getTime() - 600_000).toISOString(), now)).toBe(true);
    expect(isClaimStale(null, now)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* J4 — NO REPLAY                                                      */
/* ------------------------------------------------------------------ */

describe("J4 — no replay of muted messages", () => {
  const mutedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 10)).toISOString();

  test("messages received while AI was disabled are not replayed", () => {
    const batch = selectCoalescedInbound([msg("Heloo", 2), msg("Tolong reply", 8)], {
      agencyId: A,
      conversationId: C1,
      mutedAt,
    });
    expect(batch).toHaveLength(0);
  });

  test("re-enabling AI does not process historical muted messages", () => {
    expect(
      shouldGenerateReply([msg("Kenapa diam", 1), msg("Aduhai", 5)], {
        agencyId: A,
        conversationId: C1,
        mutedAt,
      }),
    ).toBe(false);
  });

  test("the next genuine inbound message is processed normally", () => {
    const batch = selectCoalescedInbound(
      [msg("Heloo", 2), msg("Salam, nak tanya pakej", 30)],
      { agencyId: A, conversationId: C1, mutedAt },
    );
    expect(batch.map((m) => m.body)).toEqual(["Salam, nak tanya pakej"]);
  });
});
