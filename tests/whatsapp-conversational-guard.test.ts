import { describe, expect, it } from "vitest";

import {
  consecutiveClarifications,
  continuityInstruction,
  inferModalityFromBody,
  isAffirmative,
  isConsequentialAction,
  isNegative,
  lastPendingQuestion,
  latencyBucket,
  latencyBucketLabel,
  presentationDelayMs,
  readContinuity,
} from "@/lib/sales/context-continuity.core";

const turn = (sender: string, body: string) => ({ sender, body });

describe("UMRAIO conversational validation guard", () => {
  it("1. clear intent needs no clarification framing", () => {
    const read = readContinuity({
      turns: [turn("customer", "Saya nak tengok pakej Umrah bulan Mac untuk 2 orang.")],
      latestCustomerMessage: "Saya nak tengok pakej Umrah bulan Mac untuk 2 orang.",
    });
    expect(read.requiresConfirmation).toBe(false);
    expect(continuityInstruction(read)).toMatch(/LOW-RISK TURN/);
    expect(read.telemetry).not.toContain("clarification_requested");
  });

  it("2. previous question + 'Ya' resolves against that question", () => {
    const q = "Datuk mahu saya bantu buka pautan QR untuk tempahan pakej Umrah, betul?";
    const read = readContinuity({
      turns: [turn("customer", "poster ni"), turn("ai", q)],
      latestCustomerMessage: "Ya.",
    });
    expect(read.affirmativeResolved).toBe(true);
    expect(read.pendingQuestion).toBe(q);
    expect(read.intentStatus).toBe("resolved");
    expect(continuityInstruction(read)).toMatch(/AFFIRMATIVE BINDING/);
    expect(read.telemetry).toContain("affirmative_context_resolved");
  });

  it("3. 'Betul' / 'Okay' / 'Baik' also resolve the previous question", () => {
    for (const reply of ["Betul", "Okay", "Ya, betul", "Baik", "Boleh"]) {
      const read = readContinuity({
        turns: [turn("ai", "Datuk nak saya semak pakej yang sesuai?")],
        latestCustomerMessage: reply,
      });
      expect(isAffirmative(reply)).toBe(true);
      expect(read.affirmativeResolved).toBe(true);
    }
    expect(isNegative("Tak payah")).toBe(true);
    expect(isAffirmative("Tak payah")).toBe(false);
  });

  it("4. repeated clarification loops are detected and broken", () => {
    const turns = [
      turn("ai", "Datuk nak tempah atau nak maklumat?"),
      turn("customer", "Maklumat"),
      turn("ai", "Maklumat pakej atau maklumat QR?"),
    ];
    expect(consecutiveClarifications(turns)).toBeGreaterThanOrEqual(2);
    const read = readContinuity({ turns, latestCustomerMessage: "Ya" });
    expect(read.clarificationLoopRisk).toBe(true);
    expect(continuityInstruction(read)).toMatch(/LOOP BREAKER/);
  });

  it("5. poster + request to analyse is answered, not questioned", () => {
    const read = readContinuity({
      turns: [turn("customer", "[Gambar daripada pelanggan] Poster promosi pakej Umrah")],
      latestCustomerMessage: "Boleh ulas dulu berkenaan poster tu?",
      modality: "image",
    });
    expect(read.analysisRequested).toBe(true);
    expect(read.intentStatus).toBe("resolved");
    expect(continuityInstruction(read)).toMatch(/VISUAL CONTEXT/);
    expect(read.telemetry).toContain("clarification_avoided");
  });

  it("6. a QR in the image does not trigger an automatic clarification loop", () => {
    const read = readContinuity({
      turns: [turn("customer", "[Gambar daripada pelanggan] Poster dengan kod QR")],
      latestCustomerMessage: "Ada QR dalam poster tu",
      modality: "image",
    });
    expect(read.qrPresent).toBe(true);
    const text = continuityInstruction(read);
    expect(text).toMatch(/only act on the QR when the customer explicitly asks/i);
    expect(text).toMatch(/VISUAL CONTEXT/);
  });

  it("7. voice turns keep previous conversational context", () => {
    const read = readContinuity({
      turns: [turn("ai", "Berapa orang yang akan pergi?")],
      latestCustomerMessage: "Empat orang",
      modality: "audio",
    });
    expect(continuityInstruction(read)).toMatch(/not a brand-new intent/);
    expect(inferModalityFromBody("[Gambar daripada pelanggan] poster")).toBe("image");
    expect(inferModalityFromBody("hello")).toBe("text");
  });

  it("8. ambiguous low-risk request prefers inference", () => {
    const read = readContinuity({
      turns: [],
      latestCustomerMessage: "Ada apa-apa untuk bulan puasa?",
    });
    expect(read.requiresConfirmation).toBe(false);
    expect(continuityInstruction(read)).toMatch(/best-effort inference/);
  });

  it("9. consequential action still requires one confirmation", () => {
    const read = readContinuity({
      turns: [],
      latestCustomerMessage: "Saya nak bayar deposit sekarang",
    });
    expect(isConsequentialAction("Saya nak bayar deposit sekarang")).toBe(true);
    expect(read.requiresConfirmation).toBe(true);
    expect(continuityInstruction(read)).toMatch(/CONSEQUENTIAL ACTION/);
  });

  it("10. resolved intent is not re-validated", () => {
    const read = readContinuity({
      turns: [turn("ai", "Saya semak pakej Mac untuk 2 orang, betul?")],
      latestCustomerMessage: "Ya",
    });
    const text = continuityInstruction(read);
    expect(text).toMatch(/Never re-validate an intent that is already resolved/);
    expect(text).toMatch(/do NOT restart intent discovery/);
  });

  it("11. last pending question only binds to the newest outbound question", () => {
    expect(lastPendingQuestion([turn("ai", "Terima kasih.")])).toBeNull();
    expect(
      lastPendingQuestion([turn("ai", "Baik. Bulan bila? Berapa orang?")]),
    ).toBe("Berapa orang?");
  });

  it("12. humanised timing pads only fast replies and never slows real ones", () => {
    expect(latencyBucket({ modality: "text", replyLength: 40 })).toBe("short");
    expect(latencyBucket({ modality: "image", replyLength: 200 })).toBe("considered");
    expect(presentationDelayMs({ elapsedMs: 200, modality: "text", replyLength: 40 })).toBeGreaterThan(0);
    expect(presentationDelayMs({ elapsedMs: 200, modality: "text", replyLength: 40 })).toBeLessThanOrEqual(1_500);
    expect(presentationDelayMs({ elapsedMs: 9_000, modality: "text", replyLength: 400 })).toBe(0);
    expect(latencyBucketLabel(1_000)).toBe("lt_2s");
    expect(latencyBucketLabel(5_000)).toBe("4_6s");
  });

  it("13. telemetry never carries identities or message contents", () => {
    const read = readContinuity({
      turns: [turn("ai", "Nak saya semak pakej?")],
      latestCustomerMessage: "Ya",
    });
    for (const label of read.telemetry) {
      expect(label).toMatch(/^[a-z_]+$/);
    }
  });
});
