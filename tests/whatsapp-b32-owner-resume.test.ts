import { describe, expect, it } from "vitest";

import { detectHumanRequest } from "@/lib/sales/hardening.core";
import { selectCoalescedInbound, shouldGenerateReply } from "@/lib/whatsapp/coalescing.core";

/**
 * PHASE B-3.2 — owner AI resume must never replay muted-era messages, and the
 * B-3/B-3.1 handover classifier must remain intact.
 */
const scope = { agencyId: "a1", conversationId: "c1" };

function msg(body: string, sender: string, created_at: string) {
  return { agency_id: "a1", conversation_id: "c1", sender, body, created_at };
}

describe("B-3.2 owner resume semantics", () => {
  const mutedAt = "2026-08-24T03:32:05.000Z";
  const history = [
    msg("Salam", "customer", "2026-08-24T03:20:00.000Z"),
    msg("Helo?", "customer", "2026-08-24T03:31:00.000Z"),
  ];

  it("D — messages received while muted are never replayed after resume", () => {
    expect(selectCoalescedInbound(history, { ...scope, mutedAt })).toHaveLength(0);
    expect(shouldGenerateReply(history, { ...scope, mutedAt })).toBe(false);
  });

  it("C — a NEW inbound after resume is answered", () => {
    const withNew = [...history, msg("Harga pakej?", "customer", "2026-08-24T04:00:00.000Z")];
    const pending = selectCoalescedInbound(withNew, { ...scope, mutedAt });
    expect(pending.map((m) => m.body)).toEqual(["Harga pakej?"]);
  });

  it("J — another tenant's messages are never selected", () => {
    const foreign = [
      { ...msg("Hi", "customer", "2026-08-24T04:00:00.000Z"), agency_id: "other" },
    ];
    expect(selectCoalescedInbound(foreign, { ...scope, mutedAt })).toHaveLength(0);
  });

  it("H — a rapid burst resolves to one coalesced batch", () => {
    const burst = [
      msg("Heloo", "customer", "2026-08-24T04:00:00.000Z"),
      msg("Awak ada?", "customer", "2026-08-24T04:00:02.000Z"),
    ];
    expect(selectCoalescedInbound(burst, { ...scope, mutedAt })).toHaveLength(2);
  });

  it("E/F — handover classifier is preserved", () => {
    for (const p of [
      "Cakap macam orang.",
      "Kenapa cakap macam robot?",
      "Cakap elok sikit.",
      "Suara macam robot.",
    ]) {
      expect(detectHumanRequest(p), p).toBe(false);
    }
    for (const p of [
      "Saya nak cakap dengan staff.",
      "Transfer saya kepada staff.",
      "Saya mahu human agent.",
      "Boleh bagi customer service?",
      "Sambungkan saya dengan pegawai.",
      "Jawab macam orang, tapi saya nak cakap dengan staff.",
    ]) {
      expect(detectHumanRequest(p), p).toBe(true);
    }
  });
});
