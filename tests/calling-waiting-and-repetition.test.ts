import { expect, it } from "vitest";

import { withCallingBackchannel } from "../src/lib/calls/call-backchannel.core";
import { contextualAcknowledgement, waitingPhrase } from "../src/lib/calls/call-executive.core";
import { forwardMovingResponse, repeatsPreviousSpeech, requestsRepetition } from "../src/lib/calls/call-repetition.core";

const address = { honorific: "Dato’", spoken: "Dato’ Synthetic" } as never;
const opener = (text: string) => text.trim().split(/[\s,.]+/)[0]!.toLowerCase();

it("never stacks the same opener as the acknowledgement already spoken", () => {
  for (const language of ["ms-MY", "en-US"]) {
    for (let seed = 0; seed < 6; seed += 1) {
      const ack = contextualAcknowledgement({ address, language, transcript: "Berapa harga pakej?" });
      const waiting = waitingPhrase(address, language, { seed, avoid: ack });
      expect(opener(waiting)).not.toBe(opener(ack));
    }
  }
});

it("varies the waiting phrase across turns instead of always using the first line", () => {
  const spoken = new Set([0, 1, 2].map(seed => waitingPhrase(address, "ms-MY", { seed })));
  expect(spoken.size).toBeGreaterThan(1);
});

it("emits the late reassurance only for a genuinely slow answer", async () => {
  const slow = new Promise(resolve => setTimeout(() => resolve("done"), 60));
  const result = await withCallingBackchannel({ answer: slow, emit: () => {}, emitLate: () => {}, delayMs: 1, lateDelayMs: 10 });
  expect(result.emitted).toBe(true);
  expect(result.emittedLate).toBe(true);

  const fast = await withCallingBackchannel({ answer: Promise.resolve("done"), emit: () => {}, emitLate: () => {}, delayMs: 1, lateDelayMs: 10 });
  expect(fast.emittedLate).toBe(false);
});

it("replaces a repeated substantive answer with one forward-moving question", () => {
  const prior = "Pakej Umrah kami bermula dari RM 9,800 seorang termasuk penerbangan dan hotel lima bintang.";
  expect(repeatsPreviousSpeech(prior, [prior])).toBe(true);
  expect(requestsRepetition("boleh ulang sekali lagi?")).toBe(true);
  const forward = forwardMovingResponse("ms-MY", "Dato’", 1);
  expect(repeatsPreviousSpeech(forward, [prior])).toBe(false);
  expect(forward).toContain("?");
});
