import { describe, expect, it } from "vitest";

import { detectOptOut } from "@/lib/sales/hardening.core";
import { decideVoiceReply, toSpeakableText } from "@/lib/voice/tts.core";
import { selectCoalescedInbound, shouldGenerateReply } from "@/lib/whatsapp/coalescing.core";
import { readContinuity } from "@/lib/sales/context-continuity.core";

/**
 * INCIDENT 2026-08-23 — a voice turn transcribed as "awak jangan tanya lagi"
 * was classified as a permanent DO-NOT-CONTACT opt-out. The conversation was
 * silenced (ai_enabled=false) and every later turn produced NO reply at all.
 */
describe("incident regression — false-positive opt-out silencing the conversation", () => {
  it("conversational impatience is NEVER an opt-out", () => {
    for (const phrase of [
      "Ya, betul. Awak jangan tanya lagi. Saya nak tulis tu, susunkan teks Arab ejaan.",
      "jangan tanya lagi",
      "jangan ulang soalan lagi",
      "jangan sebut benda tu lagi",
      "eh mana doanya? saya tunggu ni lamanya",
    ]) {
      expect(detectOptOut(phrase).optedOut).toBe(false);
    }
  });

  it("genuine contact opt-outs are still detected", () => {
    for (const phrase of [
      "jangan whatsapp lagi",
      "Jangan hantar mesej lagi",
      "jangan hubungi saya lagi",
      "berhenti hantar mesej",
      "stop messaging me",
      "unsubscribe",
      "tak nak terima promosi",
      "please remove my number",
      "jangan ganggu saya lagi",
    ]) {
      expect(detectOptOut(phrase).optedOut).toBe(true);
    }
  });
});

const turn = (
  sender: string,
  body: string,
  created_at: string,
): {
  agency_id: string;
  conversation_id: string;
  sender: string;
  body: string;
  created_at: string;
} => ({ agency_id: "a1", conversation_id: "c1", sender, body, created_at });

describe("incident regression — a later turn always gets its own reply", () => {
  const scope = { agencyId: "a1", conversationId: "c1" };

  it("voice B after a completed voice A turn is answerable", () => {
    const history = [
      turn("customer", "[voice] pakej Disember", "2026-08-23T07:53:00.000Z"),
      turn("ai", "Baik, saya semak pakej Disember.", "2026-08-23T07:53:30.000Z"),
      turn("customer", "[voice] berapa harga", "2026-08-23T07:55:00.000Z"),
    ];
    expect(shouldGenerateReply(history, scope)).toBe(true);
    expect(selectCoalescedInbound(history, scope)).toHaveLength(1);
  });

  it("text after voice, voice after text and voice after an image all stay answerable", () => {
    const cases = [
      ["[voice] salam", "helo nak tanya harga"],
      ["helo nak tanya harga", "[voice] salam"],
      ["[Gambar daripada pelanggan] poster pakej", "[voice] boleh ulas poster tu"],
    ];
    for (const [first, second] of cases) {
      const history = [
        turn("customer", first as string, "2026-08-23T07:50:00.000Z"),
        turn("ai", "Baik.", "2026-08-23T07:50:20.000Z"),
        turn("customer", second as string, "2026-08-23T07:52:00.000Z"),
      ];
      expect(shouldGenerateReply(history, scope)).toBe(true);
    }
  });

  it("a completed turn leaves nothing to re-answer (no duplicate replies)", () => {
    const history = [
      turn("customer", "[voice] salam", "2026-08-23T07:53:00.000Z"),
      turn("ai", "Waalaikumussalam.", "2026-08-23T07:53:30.000Z"),
    ];
    expect(shouldGenerateReply(history, scope)).toBe(false);
  });

  it("a rapid burst still coalesces into exactly one answer", () => {
    const history = [
      turn("customer", "Helo", "2026-08-23T07:53:00.000Z"),
      turn("customer", "Awak ada?", "2026-08-23T07:53:01.000Z"),
      turn("customer", "[voice] nak tanya pakej", "2026-08-23T07:53:02.000Z"),
    ];
    expect(selectCoalescedInbound(history, scope)).toHaveLength(3);
  });

  it("context continuity survives the voice turn", () => {
    const read = readContinuity({
      turns: [{ sender: "ai", body: "Tuan nak saya semak pakej Disember?" }],
      latestCustomerMessage: "Ya",
      modality: "audio",
    });
    expect(read.affirmativeResolved).toBe(true);
  });
});

describe("incident regression — voice never blocks text", () => {
  it("a failed / undeliverable voice reply is a text-only outcome, not a dropped turn", () => {
    // The decision layer is the only thing between a text reply and a spoken
    // one; every negative outcome simply leaves the already-sent text.
    expect(decideVoiceReply({ inboundModality: "audio", replyText: "" }).speak).toBe(false);
    expect(decideVoiceReply({ inboundModality: "audio", replyText: "a".repeat(5000) }).speak).toBe(
      false,
    );
    expect(decideVoiceReply({ inboundModality: "text", replyText: "Hai" }).speak).toBe(false);
    expect(decideVoiceReply({ inboundModality: "audio", replyText: "Hai Tuan" }).speak).toBe(true);
  });

  it("internal reference codes and links are never spoken", () => {
    const spoken = toSpeakableText(
      "**Baik Datuk**\n- Rujukan IIL-MT5ABC dan HO-XY12Z\nLihat https://umraio.com",
    );
    expect(spoken).not.toMatch(/IIL-|HO-/);
    expect(spoken).not.toContain("http");
    expect(spoken).not.toContain("*");
    expect(spoken).toContain("Baik Datuk");
  });

  it("speech text is segmented into complete spoken sentences", () => {
    const spoken = toSpeakableText("Baik Datuk\nPakej Disember ada\nHarga RM9,900");
    expect(spoken).toBe("Baik Datuk. Pakej Disember ada. Harga RM9,900.");
  });
});
