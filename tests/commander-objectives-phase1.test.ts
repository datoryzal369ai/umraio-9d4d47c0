import { describe, expect, it } from "vitest";

import {
  isObjectiveStatus,
  objectiveTargetLabel,
  validateObjectiveInput,
  type ExecutiveObjective,
} from "@/lib/executive/objectives.core";

describe("COMMANDER PHASE 1 — objective validation", () => {
  it("accepts a full objective", () => {
    const v = validateObjectiveInput({
      objectiveText:
        "I want 30 Umrah bookings for Ramadan 2027 within 30 days from families in Johor.",
      metric: "bookings",
      quantity: 30,
      deadline: "2027-02-01",
      segment: "families in Johor",
    });
    expect(v.objective_text).toContain("30 Umrah bookings");
    expect(v.target_quantity).toBe(30);
    expect(v.deadline).toBe("2027-02-01");
    expect(v.parsed_metric).toBe("bookings");
    expect(v.target_segment).toBe("families in Johor");
  });

  it("accepts objective text alone with no invented structure", () => {
    const v = validateObjectiveInput({ objectiveText: "Grow Ramadan demand" });
    expect(v.target_quantity).toBeNull();
    expect(v.deadline).toBeNull();
    expect(v.parsed_metric).toBeNull();
    expect(v.target_segment).toBeNull();
  });

  it("rejects an empty objective", () => {
    expect(() => validateObjectiveInput({ objectiveText: "   " })).toThrow(/required/i);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => validateObjectiveInput({ objectiveText: "x", quantity: 0 })).toThrow(/positive/i);
    expect(() => validateObjectiveInput({ objectiveText: "x", quantity: -5 })).toThrow(/positive/i);
  });

  it("rejects an invalid deadline", () => {
    expect(() => validateObjectiveInput({ objectiveText: "x", deadline: "next Ramadan" })).toThrow(
      /valid date/i,
    );
  });

  it("only allows the minimal lifecycle statuses", () => {
    expect(isObjectiveStatus("active")).toBe(true);
    expect(isObjectiveStatus("completed")).toBe(true);
    expect(isObjectiveStatus("closed")).toBe(true);
    expect(isObjectiveStatus("executing")).toBe(false);
  });

  it("never fabricates a target that was not given", () => {
    const base: ExecutiveObjective = {
      id: "1",
      agency_id: "a",
      created_by: null,
      objective_text: "Grow Ramadan demand",
      parsed_metric: null,
      target_quantity: null,
      deadline: null,
      target_segment: null,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(objectiveTargetLabel(base)).toBe("Not specified");
    expect(
      objectiveTargetLabel({ ...base, target_quantity: 30, parsed_metric: "bookings" }),
    ).toBe("30 bookings");
  });
});
