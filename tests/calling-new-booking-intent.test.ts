import { expect, it } from "vitest";
import { newBookingRequest } from "../src/lib/calls/cognitive-state.server";
import { packetFixture } from "./helpers/calling-cognitive-fixtures";

const phrases = ["nak tempah","saya nak tempah","nak booking","saya nak booking","tempah pakej","pilih pakej","nak daftar","nak teruskan","tempah","nak tempah pakej"];
it("recognises every new-booking phrase", () => { for (const p of phrases) expect(newBookingRequest.test(p), p).toBe(true); });
it("does not treat an existing-booking question as new", () => {
  expect(newBookingRequest.test("status tempahan saya")).toBe(false);
});
it("a new booking request never becomes an existing-booking identity topic", () => {
  for (const p of ["nak tempah pakej", "saya nak booking"]) {
    const packet = packetFixture(p) as any;
    expect(JSON.stringify(packet.dialogue ?? packet).includes('"topic":"booking"'), p).toBe(false);
  }
});
