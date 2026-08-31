import { describe, expect, it } from "vitest";

import {
  buildConfidenceRead,
  confidentPresenceInstruction,
  detectCapabilityAsk,
  detectCustomerTarget,
  detectMomentumRequest,
  detectPositiveProgress,
  detectSmallVolumeFraming,
} from "@/lib/sales/confident-presence.core";

function read(...customerMessages: string[]) {
  return buildConfidenceRead({ customerMessages });
}

describe("STEP 3D.2 — detection", () => {
  it("detects capability asks in BM, English and Manglish", () => {
    expect(detectCapabilityAsk("Boleh bantu naikkan sales?")).toBe(true);
    expect(detectCapabilityAsk("Can you help with follow-up?")).toBe(true);
    expect(detectCapabilityAsk("Macam mana nak sales meroket?")).toBe(true);
    expect(detectCapabilityAsk("Package ini untuk Ramadan.")).toBe(false);
  });

  it("detects customer targets without treating them as guarantees", () => {
    expect(detectCustomerTarget("Saya sekurang-kurangnya nak 10 jemaah close")).toMatchObject({
      value: 10,
      unit: "jemaah",
    });
    expect(detectCustomerTarget("Target 20 booking bulan depan")).toMatchObject({ value: 20 });
    expect(detectCustomerTarget("Bulan lepas ada 10 jemaah pergi")).toBeNull();
  });

  it("detects small volume framing, momentum and progress", () => {
    expect(detectSmallVolumeFraming("Kalau 1 jemaah?")).toBe(true);
    expect(detectMomentumRequest("Okay, macam mana nak mula?")).toBe(true);
    expect(detectPositiveProgress("Sekarang sales dah mula naik")).toBe(true);
    expect(detectPositiveProgress("Sales saya slow")).toBe(false);
  });
});

describe("STEP 3D.2 — read modes", () => {
  it("owns a stated target", () => {
    const r = read("Langsung tak follow up. Saya sekurang2nya 10 jemaah close. Boleh?");
    expect(r.mode).toBe("TARGET_OWNERSHIP");
    expect(r.target?.value).toBe(10);
    expect(r.allowInsyaAllah).toBe(true);
  });

  it("answers 'boleh?' directly", () => {
    expect(read("Boleh bantu follow-up?").mode).toBe("REASSURE_AND_EXECUTE");
    expect(read("Staff tak follow-up. Boleh tolong?").directAnswerRequired).toBe(true);
  });

  it("respects small volume and momentum", () => {
    expect(read("Kalau 1 jemaah?").mode).toBe("SMALL_VOLUME_RESPECT");
    expect(read("Nak mula macam mana?").mode).toBe("MOMENTUM");
  });

  it("celebrates real progress only", () => {
    const r = read("Sekarang sales dah mula naik");
    expect(r.mode).toBe("CELEBRATE_PROGRESS");
    expect(r.allowAlhamdulillah).toBe(true);
    expect(read("Mahal juga").allowAlhamdulillah).toBe(false);
  });

  it("stays neutral for price and trust concerns without forced religious filler", () => {
    const price = read("Mahal juga untuk agency kecil macam kami");
    expect(price.mode).toBe("STANDARD");
    expect(price.allowInsyaAllah).toBe(false);
    const trust = read("Data customer saya selamat ke?");
    expect(trust.allowAlhamdulillah).toBe(false);
  });
});

describe("STEP 3D.2 — safety priority", () => {
  it("suppresses the layer on opt-out", () => {
    const r = read("Stop. Jangan hubungi saya lagi.");
    expect(r.mode).toBe("SUPPRESSED");
    expect(r.allowInsyaAllah).toBe(false);
    expect(confidentPresenceInstruction(r)).toMatch(/suppressed/i);
  });

  it("suppresses the layer on human handoff request", () => {
    expect(read("Saya nak cakap dengan manusia").mode).toBe("SUPPRESSED");
  });

  it("suppresses the layer when the customer is frustrated", () => {
    expect(read("Dah berkali-kali saya cakap, awak tanya soalan sama je!").mode).toBe("SUPPRESSED");
  });

  it("honours an explicit safety override", () => {
    expect(
      buildConfidenceRead({ customerMessages: ["Boleh bantu?"], safetySuppressed: true }).mode,
    ).toBe("SUPPRESSED");
  });
});

describe("STEP 3D.2 — instruction integrity", () => {
  it("forbids disclaimer-first replies and guarantees", () => {
    const text = confidentPresenceInstruction(read("Nak 10 jemaah close. Boleh?"));
    expect(text).toMatch(/tak boleh jamin/i);
    expect(text).toMatch(/never as a guaranteed outcome/i);
    expect(text).toMatch(/ACKNOWLEDGE -> CONFIDENT ANSWER -> VALUE\/EXECUTION -> ONE next step/);
  });

  it("never exposes internal psychology labels and keeps AI honesty", () => {
    const text = confidentPresenceInstruction(read("Boleh bantu naikkan sales?"));
    expect(text).toMatch(/Never expose internal analysis labels/i);
    expect(text).toMatch(/remain an AI/i);
  });

  it("blocks religious filler when not contextual", () => {
    const text = confidentPresenceInstruction(read("Berapa harga?"));
    expect(text).toMatch(/no religious expression is required/i);
  });
});
