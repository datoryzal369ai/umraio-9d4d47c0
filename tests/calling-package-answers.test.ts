import { describe, expect, it } from "vitest";
import { validateCallingDecision } from "../src/lib/calls/call-decision-policy.core";
import { callingContractRecovery } from "../src/lib/calls/call-speech-claims.core";
import { decisionFixture, packetFixture, recordsFixture } from "./helpers/calling-cognitive-fixtures";

const withPackages = () => ({ ...recordsFixture(), packages: [
  { id: "p1", name: "Umrah Ekonomi 12 Hari", nights: 11, price_myr: 9800, hotel_makkah: "Hotel A", hotel_madinah: "Hotel B", departure_date: "2026-11-01", updated_at: "2026-09-01T00:00:00Z" },
  { id: "p2", name: "Umrah Premium 10 Hari", nights: 9, price_myr: 14800, hotel_makkah: "Hotel C", hotel_madinah: "Hotel D", departure_date: null, updated_at: "2026-09-01T00:00:00Z" },
] });
const state = (p: ReturnType<typeof packetFixture>) => ({ live: true, revision: p.identity.input_revision, generation: p.identity.generation, current_sequence: 2, cancelled: false } as never);

describe("Calling package answers", () => {
  it.each(["Nak tanya pakej Umrah", "Senarai pakej Umrah"])("supplies active package facts for %s", text => {
    const packet = packetFixture(text, withPackages());
    for (const f of ["name", "nights", "price_myr", "hotel_makkah", "hotel_madinah"]) expect(packet.business.package_refs).toContain(`packages:p1:${f}`);
    expect(packet.evidence.find(e => e.id === "packages:p1:price_myr")).toMatchObject({ value: 9800, verification: "verified", authority: "business_record" });
  });
  it("accepts a valid factual answer ending with one closing question", () => {
    const packet = packetFixture("Nak tanya pakej Umrah", withPackages());
    const d = decisionFixture(packet, { interaction_mode: "ANSWER", intent: "package_info", authoritative_facts_used: ["packages:p1:name", "packages:p1:price_myr"],
      spoken_response: "Pakej Umrah Ekonomi 12 Hari berharga RM9,800 seorang. Dato' nak saya terangkan hotelnya?" });
    expect(validateCallingDecision(d, packet, state(packet)).ok).toBe(true);
  });
  it("still rejects more than one question in an answer", () => {
    const packet = packetFixture("Nak tanya pakej Umrah", withPackages());
    const d = decisionFixture(packet, { interaction_mode: "ANSWER", spoken_response: "Nak yang mana? Berapa orang?" });
    expect(validateCallingDecision(d, packet, state(packet))).toMatchObject({ ok: false, reason: "unclassified_question" });
  });
  it("still rejects an unsupported claim", () => {
    const packet = packetFixture("Nak tanya pakej Umrah", withPackages());
    const d = decisionFixture(packet, { interaction_mode: "ANSWER", spoken_response: "Harganya RM1,000.",
      claim_requests: [{ kind: "business_status", source_ref: "packages:p1:price_myr", spoken_span: "RM1,000" }] });
    expect(validateCallingDecision(d, packet, state(packet)).ok).toBe(false);
  });
  it("keeps recovery on the package topic, never WhatsApp history", () => {
    const packet = packetFixture("Senarai pakej Umrah", withPackages());
    const r = callingContractRecovery(packet);
    expect(r.spoken_response).toContain("Umrah Ekonomi 12 Hari");
    expect(r.spoken_response).not.toMatch(/sejarah perbualan|WhatsApp/i);
    expect(validateCallingDecision(r, packet, state(packet)).ok).toBe(true);
    const empty = callingContractRecovery(packetFixture("Nak tanya pakej Umrah", recordsFixture()));
    expect(empty.spoken_response).toMatch(/pakej Umrah/);
  });
});
