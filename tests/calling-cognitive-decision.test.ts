import { describe, expect, it } from "vitest";
import { validateCallingDecision } from "../src/lib/calls/call-decision-policy.core";
import { packetFixture, decisionFixture } from "./helpers/calling-cognitive-fixtures";
const current = { revision: 2, generation: "generation-2", live: true, cancelled: false };

describe("Calling semantic contract and application policy", () => {
  it("permits reciprocal SOCIAL output without invoking a sales tool", () => {
    const p = packetFixture(); const result = validateCallingDecision(decisionFixture(p), p, current);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.decision.interaction_mode).toBe("SOCIAL"); expect(result.decision.action_required).toBe(false); }
  });
  it.each(["Ja", "Skjab, skjab", "Saya nak e-mel belum boleh hantar."])("accepts clarification without entity mutation: %s", text => {
    const p = packetFixture(text); const missing = p.dialogue!.missing!;
    const d = decisionFixture(p, { interaction_mode: "CLARIFY", requires_clarification: true,
      clarification: {fact: missing.fact, key: missing.key},
      uncertainties: [{ detail: "The caller request is missing", source_refs: [`caller:${p.identity.caller_turn_id}`] }], spoken_response: missing.question });
    expect(validateCallingDecision(d, p, current).ok).toBe(true);
    expect(validateCallingDecision({...d, spoken_response:"Maksudnya macam mana ya?"}, p, current)).toEqual({ok:false,reason:"generic_clarification"});
    expect(d.memory_update.corrections).toEqual([]);
  });
  it.each([
    { packet_id: "old-packet" }, { input_revision: 1 }, { generation: "old" }, { caller_turn_id: "another-turn" },
    { next_state: "terminal" }, { authoritative_facts_used: ["invented-record"] }, { allowed_tool: "delete_booking" },
  ])("rejects stale/invented/unauthorized model output %j", change => {
    const p = packetFixture(); expect(validateCallingDecision({ ...decisionFixture(p), ...change }, p, current).ok).toBe(false);
  });
  it.each([{ ...current, cancelled: true }, { ...current, live: false }, { ...current, revision: 3 }, { ...current, generation: "new" }])("blocks superseded/cancelled/terminal ownership %j", ownership => {
    const p = packetFixture(); expect(validateCallingDecision(decisionFixture(p), p, ownership).ok).toBe(false);
  });
  it("rejects a model-invented correction even with a real caller citation", () => {
    const p = packetFixture("Ja"); const d = decisionFixture(p, { memory_update: { objective: null, open_questions: [], corrections: [
      { text: "Traveller's name is Ja", evidence_quote: "Ja", source_refs: ["caller:caller-2"] },
    ] } });
    expect(validateCallingDecision(d, p, current)).toEqual({ ok: false, reason: "unsupported_memory" });
  });
  it.each(["Saya akan hantar quotation.", "Quotation dah dihantar.", "Kami akan uruskan.", "Pihak agensi akan hantar.", "Quotation akan dihantar nanti.", "I'll send it.", "We will arrange the booking."])("blocks unsupported execution claims: %s", speech => {
    const p = packetFixture(); expect(validateCallingDecision(decisionFixture(p, { spoken_response: speech }), p, current).ok).toBe(false);
  });
  it("rejects an execution decision while the caller meaning is unresolved", () => {
    const p = packetFixture("Hantar quotation sekarang"); const d = decisionFixture(p, { interaction_mode: "EXECUTE", action_required: true,
      requested_action: { name: "deliver_existing_quotation_whatsapp", quotation_id: "quote", evidence_quote: "Hantar quotation sekarang" },
      allowed_tool: "deliver_existing_quotation_whatsapp", uncertainties: [{ detail: "Who is recipient?", source_refs: [] }] });
    expect(validateCallingDecision(d, p, current).ok).toBe(false);
  });
  it("does not treat an ambiguous OK as automatic completion", () => {
    const p = packetFixture("OK."); const d = decisionFixture(p, { interaction_mode: "CLOSE", next_state: "farewell_committed",
      completion_intent: "confirmed", spoken_response: "Terima kasih. Assalamualaikum." });
    expect(validateCallingDecision(d, p, current)).toEqual({ ok: false, reason: "ambiguous_completion" });
  });
});
