import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildAcknowledgement,
  isBookingStatusTurn,
  resolveAddress,
  resolveBookingStatus,
  routeTurn,
} from "@/lib/calls/cognitive-router.core";

const address = resolveAddress(null);

describe("Founder live acceptance — authoritative Cognitive Bridge fast paths", () => {
  it.each(["awak sihat?", "apa khabar?", "hello", "salam", "terima kasih", "baik"])(
    "%s is a zero-model reflex",
    (transcript) => {
      const route = routeTurn({ transcript, language: "ms-MY", address });
      expect(route).toMatchObject({ level: 0, reflex: true, acknowledgement: null });
      expect(route.reflexText?.trim()).toBeTruthy();
    },
  );

  it("does not use the prohibited spoken word in BM deep-turn acknowledgements", () => {
    for (let seed = 0; seed < 6; seed += 1) {
      expect(buildAcknowledgement({ address, language: "ms-MY", seed })).not.toMatch(/semak/i);
    }
  });

  it("wires social reflex and booking status into the authoritative Cognitive Bridge", () => {
    const source = readFileSync("src/lib/calls/cognitive-bridge.server.ts", "utf8");
    expect(source).toContain("routeTurn({ transcript: lease.turn.transcript");
    expect(source).toContain("if (route.reflex && route.reflexText)");
    expect(source).toContain("isBookingStatusTurn(lease.turn.transcript)");
    expect(source).toContain("resolveBookingStatus({");
    expect(source).not.toContain("@/lib/voice/");
  });
});

describe("Founder live acceptance — governed booking continuity", () => {
  it.each([
    "saya nak check tempahan saya",
    "tempahan saya macam mana?",
    "booking saya macam mana?",
    "status booking saya?",
  ])("recognises booking-status intent: %s", (transcript) => {
    expect(isBookingStatusTurn(transcript)).toBe(true);
  });

  it("answers an authorised existing booking from verified status only", () => {
    const answer = resolveBookingStatus({
      knownCustomer: true,
      authorized: true,
      recordFound: true,
      status: "deposit_paid",
      retrievalFailed: false,
      verificationAlreadyAsked: false,
      language: "ms-MY",
    });
    expect(answer).toContain("deposit sudah diterima");
    expect(answer).not.toMatch(/RM|jumlah|baki/i);
  });

  it("asks exactly one useful question when recognition is insufficient for authorisation", () => {
    const answer = resolveBookingStatus({
      knownCustomer: true,
      authorized: false,
      recordFound: true,
      status: "confirmed",
      retrievalFailed: false,
      verificationAlreadyAsked: false,
      language: "ms-MY",
    });
    expect(answer.match(/\?/g)).toHaveLength(1);
    expect(answer).not.toContain("confirmed");
  });

  it("does not repeat the verification question", () => {
    const answer = resolveBookingStatus({
      knownCustomer: true,
      authorized: false,
      recordFound: true,
      status: "confirmed",
      retrievalFailed: false,
      verificationAlreadyAsked: true,
      language: "ms-MY",
    });
    expect(answer).not.toContain("?");
    expect(answer).toMatch(/WhatsApp/);
  });

  it("returns useful speech, never silence, on retrieval failure or missing record", () => {
    const failure = resolveBookingStatus({
      knownCustomer: true,
      authorized: true,
      recordFound: false,
      status: null,
      retrievalFailed: true,
      verificationAlreadyAsked: false,
      language: "ms-MY",
    });
    const missing = resolveBookingStatus({
      knownCustomer: true,
      authorized: true,
      recordFound: false,
      status: null,
      retrievalFailed: false,
      verificationAlreadyAsked: false,
      language: "ms-MY",
    });
    expect(failure.trim().length).toBeGreaterThan(20);
    expect(missing.trim().length).toBeGreaterThan(20);
    expect(failure).not.toMatch(/pending/i);
  });
});

describe("Founder live acceptance — observability and termination ownership", () => {
  it("keeps sanitized bridge-stage tracing and farewell ownership in the bridge", () => {
    const source = readFileSync("src/lib/calls/cognitive-bridge.server.ts", "utf8");
    expect(source).toContain("bridge_stage turn_id=call:");
    expect(source).toContain("stage=${stage} reason=${reason}");
    expect(source).toContain("endCall: nextState === \"farewell_committed\"");
    expect(source).toContain("current.farewell_id === output.farewell_id");
  });
});
