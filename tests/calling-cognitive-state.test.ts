import { describe, expect, it } from "vitest";
import { packetFixture, recordsFixture } from "./helpers/calling-cognitive-fixtures";

describe("Calling authoritative Cognitive State Packet", () => {
  it.each(["Tuan Ali", "Puan Aisyah", "Encik Ahmad", "Cik Aina", "Dato' Amin", "Tuan Haji Ali", "Hajah Zainab", "Amir"])("uses stored address without inventing Dato': %s", name => {
    const records = recordsFixture(); records.lead.full_name = name;
    const packet = packetFixture("Hello", records);
    expect(packet.evidence.find(e => packet.person.identity_refs.includes(e.id))?.value).toBe(name);
    const title = packet.evidence.find(e => e.id === packet.person.honorific_ref)?.value;
    if (!name.startsWith("Dato'")) expect(title).not.toBe("Dato'");
    expect(packet.renagi).toBeNull();
  });
  it("supplies paid booking, quotation and amount above stale lead assumptions", () => {
    const packet = packetFixture();
    expect(packet.business.selected_booking).toBe("booking");
    expect(packet.business.selected_quotation).toBe("quote");
    expect(packet.evidence.find(e => e.id === "bookings:booking:deposit_paid")).toMatchObject({ value: true, authority: "business_record", verification: "verified" });
    expect(packet.evidence.find(e => e.id === "quotations:quote:total")?.value).toBe(29400);
    expect(packet.evidence.every(e => e.source.record_id && e.observed_at && e.verification && e.authority && Array.isArray(e.conflicts))).toBe(true);
  });
  it("does not substitute a newest unrelated booking when a linked quotation is named", () => {
    const records = recordsFixture();
    records.quotations.unshift({ id: "new-quote", quotation_number: "Q-2026-0008", status: "pending", total: 100 });
    records.bookings.unshift({ id: "new-booking", quotation_id: "new-quote", status: "pending", deposit_paid: false });
    const packet = packetFixture("Quotation Q-2026-0007 saya macam mana?", records);
    expect(packet.business.selected_booking).toBe("booking"); expect(packet.business.selected_quotation).toBe("quote");
    expect(packet.business.booking_refs.every(ref => !ref.includes("new-booking"))).toBe(true);
    const ambiguous = packetFixture("Booking saya macam mana?", records);
    expect(ambiguous.business.selected_booking).toBeNull();
    expect(ambiguous.available_actions).toEqual([]);
    expect(ambiguous.uncertainties.some(u => u.id === "record_selection" && u.blocking)).toBe(true);
  });
  it("exposes a stale quotation payment status without discarding the authoritative deposit", () => {
    const records = recordsFixture(); records.quotations[0].status = "deposit_pending";
    const packet = packetFixture("Deposit saya?", records);
    expect(packet.evidence.find(e => e.id === "quotations:quote:status")).toMatchObject({ verification: "conflicted", conflicts: ["bookings:booking:deposit_paid"] });
    expect(packet.evidence.find(e => e.id === "bookings:booking:deposit_paid")?.verification).toBe("verified");
  });
  it("keeps generated and handed-off speech out of delivered history", () => {
    const events = ["proposal", "handoff", "playback_complete"].map((kind, index) => ({ id: kind, sequence: index + 1, kind,
      payload: { text: kind }, created_at: "2026-09-10T17:00:00Z" }));
    const packet = packetFixture("Okay", recordsFixture(), { events });
    expect(packet.current_call.delivered_assistant_refs).toEqual(["playback:playback_complete"]);
    expect(packet.evidence.some(e => (e.value as { text?: string })?.text === "proposal")).toBe(false);
  });
  it("marks historical promises unverified, never as open commitments", () => {
    const records = recordsFixture(); records.messages.push({ id: "old-promise", sender: "ai", body: "Pihak agensi akan hantar quotation.", modality: "text", delivery_status: "sent" });
    const packet = packetFixture("Mana quotation?", records);
    expect(packet.evidence.find(e => e.id === "messages:old-promise")).toMatchObject({ verification: "unverified", authority: "historical_claim" });
    expect(packet.open_commitment_refs).toEqual([]); expect(packet.action_result_refs).toEqual([]);
  });
  it("provides quotation execution only for an eligible current explicit request", () => {
    const records = recordsFixture();
    expect(packetFixture("Hantar quotation sekarang dekat WhatsApp, boleh?", records).available_actions).toHaveLength(1);
    expect(packetFixture("Saya nak e-mel belum boleh hantar.", records).available_actions).toHaveLength(0);
    records.lead.do_not_contact = true;
    expect(packetFixture("Hantar quotation sekarang", records).available_actions).toHaveLength(0);
  });
});
