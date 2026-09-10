import { describe, expect, it } from "vitest";
import { buildAcknowledgement, resolveAddress } from "@/lib/calls/cognitive-router.core";
import { advanceClosing, isExplicitHangupCommand } from "@/lib/calls/call-experience.core";
import { acknowledgementOptions, contextualAcknowledgement, deliveredHistory, entityDecision, preventUnverifiedActionClaim, reconcilePlayback, requestsQuotationSend, structuredCallNotes } from "@/lib/calls/call-executive.core";
import type { VoiceTranscriptTurn } from "@/lib/calls/voice-turn.core";
import { hydrateCallerContext } from "@/lib/calls/call-context.server";
import { callingDb } from "./helpers/calling-worker-db";

describe("Calling subject and meaningful acknowledgement", () => {
  it.each(["Tuan", "Puan", "Encik", "Cik", "Dato'", "Tuan Haji", "Hajah", "Datuk"])("preserves saya and standalone ya with %s", title => {
    const address = resolveAddress(`${title} Amin`);
    expect(buildAcknowledgement({ address, language: "ms", seed: 1 })).toBe(`Okay, saya periksa dulu ya ${title}.`);
    expect(buildAcknowledgement({ address, language: "ms", seed: 0 })).toBe(`Kejap ya ${title}, saya tengok dulu.`);
    for (const text of acknowledgementOptions(address, "ms")) {
      expect(text).toContain(title);
      expect(text).not.toMatch(/periksa|tengok|cek|semak|saya.*periksa/i);
    }
  });
  it("selects for meaning, avoids the last acknowledgement, and stays inside the greeting cache", () => {
    const address = resolveAddress("Dato' Amin");
    const args = { address, language: "ms" };
    const request = contextualAcknowledgement({ ...args, transcript: "Boleh jelaskan pakej?" });
    const correction = contextualAcknowledgement({ ...args, transcript: "Sebenarnya saya dah bayar" });
    const concern = contextualAcknowledgement({ ...args, transcript: "Saya risau bayaran itu" });
    expect(new Set([request, correction, concern]).size).toBe(3);
    const next = contextualAcknowledgement({ ...args, transcript: "Boleh jelaskan pakej?", previous: request });
    expect(next).not.toBe(request);
    expect(acknowledgementOptions(address, "ms")).toContain(next);
  });
});

describe("Calling entity and delivery evidence", () => {
  it.each(["Ja", "Skjab, skjab", "Ede", "X"])("does not promote uncertain fragment %s into an identity", text => {
    const decision = entityDecision(text, [], "ms");
    expect(decision.reply).toContain("Boleh ulang");
    expect(decision.confirmed).toBeUndefined();
    expect(decision.proposal).toBeUndefined();
  });
  it.each(["Nama saya Amin", "Tukar nama jemaah kepada Ali", "Untuk 3 orang"])("requires confirmation for %s", text => {
    const proposal = entityDecision(text, [], "ms");
    expect(proposal.proposal).toBe(text);
    expect(proposal.confirmed).toBeUndefined();
    const question: VoiceTranscriptTurn = { role: "umraio", text: proposal.reply!, entityProposal: proposal.proposal!, at: "now", sequence: 2, delivery: "generated" };
    expect(entityDecision("Ya betul", [question], "ms").confirmed).toBeUndefined();
    const played = reconcilePlayback([question], { prev_sequence: 2, playback_complete_ms: 22000 }, 3);
    expect(entityDecision("Ya betul", played, "ms").confirmed).toBe(text);
  });
  it("keeps only caller words and verified playback in dialogue, preserving generated audit evidence", () => {
    const history: VoiceTranscriptTurn[] = [
      { role: "customer", text: "Hello", at: "now" },
      { role: "umraio", text: "generated promise", at: "now", sequence: 1, delivery: "generated" },
      { role: "umraio", text: "real reply", at: "now", sequence: 2, delivery: "generated" },
      { role: "umraio", text: "legacy unknown", at: "now" },
    ];
    const updated = reconcilePlayback(history, { prev_sequence: 2, playback_complete_ms: 23000 }, 3);
    expect(deliveredHistory(updated).map(t => t.text)).toEqual(["Hello", "real reply"]);
    expect(history[2]!.delivery).toBe("generated");
    expect(updated).toHaveLength(4);
    for (const metrics of [{ prev_sequence: 2 }, { prev_sequence: 2, playback_complete_ms: 0 }, { prev_sequence: 3, playback_complete_ms: 100 }]) {
      expect(reconcilePlayback(history, metrics, 3)).toEqual(history);
    }
  });
  it("retains bounded earlier corrections without turning generated promises into commitments", () => {
    const history: VoiceTranscriptTurn[] = Array.from({ length: 20 }, (_, i) => ({ role: "customer", at: "now", text: `Pembetulan nombor ${i}` }));
    history.push({ role: "umraio", at: "now", text: "Saya akan hantar", delivery: "generated" });
    const notes = structuredCallNotes(history);
    expect(notes).toHaveLength(6);
    expect(notes.join(" ")).not.toContain("Saya akan hantar");
    expect(notes.join(" ")).toContain("not verified execution");
  });
});

describe("Authoritative bounded Calling memory", () => {
  it.each(["accepted", "paid", "deposit_paid", "booked"])("loads %s quotation and booking despite stale lead status", async status => {
    const fixture = callingDb();
    fixture.tables.quotations![0].status = status;
    fixture.tables.messages!.push(
      { conversation_id: "conversation", sender: "customer", body: "Saya sudah bayar", modality: "voice_note" },
      { conversation_id: "conversation", sender: "ai", body: "Unsent fiction", delivery_status: "send_failed" },
      { conversation_id: "conversation", sender: "ai", body: "Earlier caller correction", modality: "call_summary", delivery_status: "internal" },
    );
    const context = await hydrateCallerContext(fixture.db, { agencyId: "agency", callerPhone: "60123456789" });
    expect(context.facts["quotation_status"]).toBe(status);
    expect(context.facts["quotation_total"]).toBe(29400);
    expect(context.facts["booking"]).toMatchObject({ deposit_paid: true, status: "deposit_paid", pax: 3 });
    expect(context.promptLines.join(" ")).toContain("override lead sales stage");
    expect(context.promptLines.join(" ")).toContain("Q-TEST-0007");
    expect(context.promptLines.join(" ")).toContain("Saya sudah bayar");
    expect(context.promptLines.join(" ")).toContain("Earlier caller correction");
    expect(context.promptLines.join(" ")).not.toContain("Unsent fiction");
    expect(fixture.operations.every(op => op.kind === "select")).toBe(true);
  });
  it("does not mistake a failed booking read for a pending or absent booking", async () => {
    const fixture = callingDb(); fixture.failures.set("bookings:select", { code: "unavailable" });
    const context = await hydrateCallerContext(fixture.db, { agencyId: "agency", callerPhone: "60123456789" });
    expect(context.facts["structured_state_available"]).toBe(false);
    expect(context.promptLines.join(" ")).toContain("could not be verified");
  });
});

describe("Explicit execution and false-promise guards", () => {
  it.each(["Hantar quotation sekarang dekat WhatsApp, boleh?", "Boleh hantarkan sebut harga ke WhatsApp saya?", "Please send the quotation now"])("recognizes the actual request: %s", text => expect(requestsQuotationSend(text)).toBe(true));
  it.each(["Jangan hantar quotation", "Dah hantar quotation?", "Berapa quotation saya?", "Hantar quotation kepada isteri", "Hantar quotation esok", "Send the quotation after the call", "Hantar quotation ke 60199999999", "Email quotation itu", "Hantar quotation ke nombor baru", "Kalau saya minta hantar quotation, boleh?", "Contohnya hantar quotation", "Saya akan hantar quotation"])("does not silently widen authority: %s", text => expect(requestsQuotationSend(text)).toBe(false));
  it.each(["Saya akan hantar quotation", "Saya akan pastikan quotation itu dihantar", "Saya dah buat", "Saya uruskan", "Quotation sudah dihantar", "Saya boleh hantar", "I'll send it", "I have sent it", "It has been sent"])("blocks unverified generated claim: %s", text => expect(preventUnverifiedActionClaim(text, "ms")).toContain("Belum ada pengesahan"));
  it.each(["Deposit tempahan ialah RM3000.", "Saya dengar soalan itu.", "Boleh buka quotation yang ada?"])("preserves ordinary conversation: %s", text => expect(preventUnverifiedActionClaim(text, "ms")).toBe(text));
});

describe("Semantic farewell, never business termination", () => {
  const base = { state: "active", language: "ms", turnCount: 4, maxTurns: 60 } as const;
  it.each(["Oklah itulah, nanti saya call awak balik.", "Terima kasih, selamat tinggal.", "Awak tak putuskan ke?", "dah tak ada", "itu sahaja", "terima kasih", "selamat tinggal", "okay bye", "nanti saya call balik", "itu je", "dah selesai", "awak boleh putuskan", "boleh tamatkan panggilan"])("commits one farewell for %s", transcript => {
    const result = advanceClosing({ ...base, transcript });
    expect(result.action).toBe("farewell");
    if (result.action === "farewell") expect(result.text).not.toMatch(/apa-apa lagi|anything else|semak/i);
    expect(advanceClosing({ ...base, state: "farewell", transcript: "" }).action).toBe("await_termination");
  });
  it.each(["jangan putuskan", "kenapa tadi terputus?", "saya nak putuskan tempahan", "saya nak putuskan jumlah bayaran", "Terima kasih, saya nak tanya harga", "Dah selesai bayaran?", "Tak selesai lagi", "Tunggu, saya belum habis"])("keeps the call open: %s", transcript => {
    expect(isExplicitHangupCommand(transcript)).toBe(false);
    expect(advanceClosing({ ...base, transcript }).action).not.toBe("farewell");
    expect(advanceClosing({ ...base, state: "completion_check", transcript }).action).toBe("continue");
  });
});
