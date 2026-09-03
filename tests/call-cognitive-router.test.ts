import { describe, expect, it } from "vitest";

import {
  buildAcknowledgement,
  depthInstruction,
  honorificInstruction,
  resolveAddress,
  routeTurn,
} from "@/lib/calls/cognitive-router.core";
import { shouldApplyCallStatus } from "@/lib/calls/call-events.core";
import { recentCallInstruction } from "@/lib/calls/recent-call.core";

const address = resolveAddress(null);

describe("cognitive complexity router", () => {
  it("answers a reflex turn without reasoning", () => {
    const route = routeTurn({ transcript: "ya", language: "ms-MY", address });
    expect(route.level).toBe(0);
    expect(route.reflex).toBe(true);
    expect(route.reflexText).toBeTruthy();
    expect(route.acknowledgement).toBeNull();
  });

  it("keeps a short factual question shallow", () => {
    const route = routeTurn({ transcript: "berapa deposit?", language: "ms-MY", address });
    expect(route.level).toBeLessThanOrEqual(1);
    expect(route.acknowledgement).toBeNull();
    expect(depthInstruction(route).join(" ")).toMatch(/ONE short spoken sentence/);
  });

  it("routes comparison and objection turns to deep cognition with an acknowledgement", () => {
    const route = routeTurn({
      transcript: "kenapa mahal sangat berbanding pakej lain, boleh bagi diskaun tak",
      language: "ms-MY",
      address,
    });
    expect(route.level).toBeGreaterThanOrEqual(3);
    expect(route.acknowledgement).toBeTruthy();
  });

  it("routes document and policy work to the deepest level", () => {
    const route = routeTurn({ transcript: "boleh hantar invois dan polisi refund", language: "ms-MY", address });
    expect(route.level).toBe(4);
    expect(route.depth).toContain("Verify Sources");
    expect(route.acknowledgement).toBeTruthy();
  });

  it("acknowledgement is a short natural sentence, never a codename", () => {
    const ack = buildAcknowledgement({ address, language: "ms-MY", seed: 1 });
    expect(ack.length).toBeLessThan(140);
    expect(ack).not.toMatch(/RENAGI|RÉNAGI|LEVEL|model/i);
  });
});

describe("honorific intelligence", () => {
  it("uses a stored title exactly as recorded", () => {
    const a = resolveAddress("Dato' Seri Ahmad bin Ismail");
    expect(a.honorific).toBe("Dato' Seri");
    expect(a.spoken).toBe("Dato' Seri Ahmad");
    expect(honorificInstruction(a).join(" ")).toContain("Dato' Seri Ahmad");
  });

  it("never invents a title when none is known", () => {
    const a = resolveAddress(null);
    expect(a.honorific).toBeNull();
    expect(honorificInstruction(a).join(" ")).toMatch(/without guessing a title/i);
  });

  it("falls back to the first name when no title is stored", () => {
    expect(resolveAddress("Nurul Aina").spoken).toBe("Nurul");
  });
});

describe("call termination after answer", () => {
  it("accepts Meta terminate on an answered call", () => {
    expect(shouldApplyCallStatus("answered", "terminated")).toBe(true);
    expect(shouldApplyCallStatus("answered", "failed")).toBe(true);
  });

  it("still refuses to regress an answered call to a live state", () => {
    expect(shouldApplyCallStatus("answered", "ringing")).toBe(false);
    expect(shouldApplyCallStatus("terminated", "answered")).toBe(false);
  });
});

describe("call → text continuity", () => {
  const now = Date.parse("2026-09-04T10:00:00Z");

  it("tells the text brain a recent call happened", () => {
    const text = recentCallInstruction(
      {
        call_id: "wacid.1",
        status: "terminated",
        termination_reason: "session_timeout",
        answered_at: "2026-09-04T09:30:00Z",
        ended_at: "2026-09-04T09:40:00Z",
        call_summary: "[Ringkasan panggilan RAIŌ]\nHasil: quotation_intent",
      },
      now,
    );
    expect(text).toMatch(/never deny the call happened/i);
    expect(text).toMatch(/ended before it was properly concluded/i);
    expect(text).toContain("quotation_intent");
  });

  it("stays silent about old or missing calls", () => {
    expect(recentCallInstruction(null, now)).toBe("");
    expect(
      recentCallInstruction({ answered_at: "2026-09-01T09:00:00Z", ended_at: "2026-09-01T09:10:00Z" }, now),
    ).toBe("");
  });
});
