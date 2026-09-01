/**
 * UMRAIO® — PHASE 3 internal calendar / appointment foundation.
 *
 * Deterministic: every test pins an explicit server instant, never the live
 * clock. DB assertions are read-only privilege/policy introspection.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  APPOINTMENT_STATUSES,
  findConflicts,
  getAvailableSlots,
  hasConflict,
  resolveRequestedSlot,
  utcToAgencyLocal,
  validateTimeRange,
  zonedTimeToUtc,
  type CalendarEvent,
} from "@/lib/calendar/appointments.core";

const TZ = "Asia/Kuala_Lumpur";

const HOURS = {
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: false },
  sat: { open: "10:00", close: "14:00", closed: false },
  sun: { open: "10:00", close: "14:00", closed: true },
};

// Tuesday 2026-09-01 01:30 UTC === 09:30 Kuala Lumpur.
const NOW = new Date("2026-09-01T01:30:00.000Z");

const event = (
  startAt: string,
  endAt: string,
  status: CalendarEvent["status"] = "scheduled",
): CalendarEvent => ({ id: `e-${startAt}`, title: "Consultation", startAt, endAt, status });

describe("phase 3 — timezone integrity", () => {
  it("converts agency-local wall clock to the authoritative UTC instant", () => {
    expect(zonedTimeToUtc("2026-09-04", "10:00", TZ)?.toISOString()).toBe(
      "2026-09-04T02:00:00.000Z",
    );
    expect(zonedTimeToUtc("2026-09-04", "10:00", "UTC")?.toISOString()).toBe(
      "2026-09-04T10:00:00.000Z",
    );
  });

  it("falls back to the platform timezone for invalid or missing zones", () => {
    expect(zonedTimeToUtc("2026-09-04", "10:00", "Mars/Olympus")?.toISOString()).toBe(
      "2026-09-04T02:00:00.000Z",
    );
    expect(utcToAgencyLocal("2026-09-04T02:00:00.000Z", null).timezone).toBe(TZ);
  });

  it("handles date rollover across the timezone boundary", () => {
    expect(utcToAgencyLocal("2026-09-01T17:00:00.000Z", TZ)).toMatchObject({
      date: "2026-09-02",
      time: "01:00",
    });
    expect(utcToAgencyLocal("2026-09-01T17:00:00.000Z", "UTC").date).toBe("2026-09-01");
  });

  it("rejects invalid dates and times instead of guessing", () => {
    expect(zonedTimeToUtc("2026-02-30", "10:00", TZ)).toBeNull();
    expect(zonedTimeToUtc("2026-09-04", "25:00", TZ)).toBeNull();
  });
});

describe("phase 3 — time range validation", () => {
  it("accepts a valid range and reports the duration", () => {
    expect(
      validateTimeRange("2026-09-04T02:00:00.000Z", "2026-09-04T03:00:00.000Z"),
    ).toMatchObject({ valid: true, durationMinutes: 60 });
  });

  it("rejects an inverted range", () => {
    expect(
      validateTimeRange("2026-09-04T03:00:00.000Z", "2026-09-04T02:00:00.000Z"),
    ).toMatchObject({ valid: false, reason: "end_before_start" });
  });

  it("rejects malformed timestamps and out-of-range durations", () => {
    expect(validateTimeRange("nope", "2026-09-04T02:00:00.000Z")).toMatchObject({
      valid: false,
      reason: "invalid_start",
    });
    expect(
      validateTimeRange("2026-09-04T02:00:00.000Z", "2026-09-05T02:00:00.000Z"),
    ).toMatchObject({ valid: false, reason: "duration_out_of_range" });
  });
});

describe("phase 3 — conflicts", () => {
  const existing = [event("2026-09-04T02:00:00.000Z", "2026-09-04T03:00:00.000Z")];

  it("detects an overlapping appointment", () => {
    expect(
      hasConflict(existing, "2026-09-04T02:30:00.000Z", "2026-09-04T03:30:00.000Z"),
    ).toBe(true);
  });

  it("treats adjacent appointments as free", () => {
    expect(
      hasConflict(existing, "2026-09-04T03:00:00.000Z", "2026-09-04T04:00:00.000Z"),
    ).toBe(false);
  });

  it("a cancelled appointment never blocks a slot", () => {
    const cancelled = [
      event("2026-09-04T02:00:00.000Z", "2026-09-04T03:00:00.000Z", "cancelled"),
    ];
    expect(hasConflict(cancelled, "2026-09-04T02:00:00.000Z", "2026-09-04T03:00:00.000Z")).toBe(
      false,
    );
  });

  it("reports every overlapping appointment", () => {
    const overlapping = [
      event("2026-09-04T02:00:00.000Z", "2026-09-04T03:00:00.000Z"),
      event("2026-09-04T02:30:00.000Z", "2026-09-04T04:00:00.000Z", "completed"),
      event("2026-09-04T05:00:00.000Z", "2026-09-04T06:00:00.000Z"),
    ];
    expect(
      findConflicts(overlapping, "2026-09-04T02:15:00.000Z", "2026-09-04T02:45:00.000Z"),
    ).toHaveLength(2);
  });
});

describe("phase 3 — availability", () => {
  const base = { timezone: TZ, businessHours: HOURS, now: NOW };

  it("returns free slots inside business hours", () => {
    const result = getAvailableSlots({ ...base, date: "2026-09-04", durationMinutes: 60 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.slots[0]).toMatchObject({
      localStart: "09:00",
      startAt: "2026-09-04T01:00:00.000Z",
    });
    // Last 60-minute slot must end at 18:00, never after closing.
    expect(result.slots[result.slots.length - 1]?.localEnd).toBe("18:00");
  });

  it("removes slots blocked by an existing appointment", () => {
    const result = getAvailableSlots({
      ...base,
      date: "2026-09-04",
      durationMinutes: 60,
      events: [event("2026-09-04T02:00:00.000Z", "2026-09-04T03:00:00.000Z")],
    });
    if (result.status !== "ok") throw new Error("expected ok");
    const starts = result.slots.map((s) => s.localStart);
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("09:30");
    expect(starts).toContain("11:00");
  });

  it("keeps slots free when the blocking appointment is cancelled", () => {
    const result = getAvailableSlots({
      ...base,
      date: "2026-09-04",
      durationMinutes: 60,
      events: [event("2026-09-04T02:00:00.000Z", "2026-09-04T03:00:00.000Z", "cancelled")],
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.slots.map((s) => s.localStart)).toContain("10:00");
  });

  it("reports a closed day rather than offering slots", () => {
    expect(getAvailableSlots({ ...base, date: "2026-09-06", durationMinutes: 60 })).toMatchObject({
      status: "closed",
      weekday: "Sunday",
    });
  });

  it("identifies a missing duration instead of inventing one", () => {
    expect(getAvailableSlots({ ...base, date: "2026-09-04" })).toMatchObject({
      status: "unresolved",
      reason: "missing_duration",
    });
  });

  it("reports unknown business hours instead of guessing", () => {
    expect(
      getAvailableSlots({ ...base, businessHours: null, date: "2026-09-04", durationMinutes: 60 }),
    ).toMatchObject({ status: "unresolved", reason: "business_hours_unknown" });
  });

  it("never offers a slot in the past", () => {
    const result = getAvailableSlots({
      ...base,
      date: "2026-09-01",
      durationMinutes: 60,
      now: new Date("2026-09-01T01:31:00.000Z"),
    });
    if (result.status !== "ok") throw new Error("expected ok");
    // 09:00 and 09:30 are already gone at the pinned 09:30 server instant.
    expect(result.slots.map((s) => s.localStart)).not.toContain("09:00");
    expect(result.slots[0]?.localStart).toBe("10:00");
  });
});

describe("phase 3 — conversational resolution", () => {
  const base = { timezone: TZ, businessHours: HOURS, now: NOW };

  it("resolves 'esok pukul 10' as available", () => {
    expect(
      resolveRequestedSlot({ ...base, phrase: "esok pukul 10 boleh?", time: "10:00", durationMinutes: 60 }),
    ).toMatchObject({ status: "available", date: "2026-09-02", startAt: "2026-09-02T02:00:00.000Z" });
  });

  it("reports a conflict with alternatives", () => {
    const result = resolveRequestedSlot({
      ...base,
      phrase: "esok",
      time: "10:00",
      durationMinutes: 60,
      events: [event("2026-09-02T02:00:00.000Z", "2026-09-02T03:00:00.000Z")],
    });
    expect(result).toMatchObject({ status: "unavailable", reason: "conflict" });
    if (result.status !== "unavailable") return;
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it("reports outside business hours", () => {
    expect(
      resolveRequestedSlot({ ...base, phrase: "esok", time: "21:00", durationMinutes: 60 }),
    ).toMatchObject({ status: "unavailable", reason: "outside_business_hours" });
  });

  it("does not guess an ambiguous date", () => {
    expect(
      resolveRequestedSlot({ ...base, phrase: "Jumaat", time: "10:00", durationMinutes: 60 }),
    ).toMatchObject({ status: "unresolved", reason: "ambiguous_date" });
  });

  it("asks for the missing duration rather than inventing one", () => {
    expect(resolveRequestedSlot({ ...base, phrase: "esok", time: "10:00" })).toMatchObject({
      status: "unresolved",
      reason: "missing_duration",
    });
  });

  it("asks for the missing time", () => {
    expect(resolveRequestedSlot({ ...base, phrase: "esok", durationMinutes: 60 })).toMatchObject({
      status: "unresolved",
      reason: "missing_time",
    });
  });

  it("resolves 'this Friday' against the agency-local date", () => {
    expect(
      resolveRequestedSlot({ ...base, phrase: "this Friday", time: "10:00", durationMinutes: 60 }),
    ).toMatchObject({ status: "available", date: "2026-09-04" });
  });
});

/* --------------------------- tenant security (read-only) -------------------------- */

const HAS_PG = Boolean(process.env.PGHOST && process.env.PGDATABASE);

function sql(query: string): string {
  return execFileSync("psql", ["-tA", "-c", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("phase 3 — appointments tenant security", () => {
  it("exposes only the three controlled states", () => {
    expect([...APPOINTMENT_STATUSES]).toEqual(["scheduled", "cancelled", "completed"]);
  });

  it.skipIf(!HAS_PG)("row level security is enabled", () => {
    expect(
      sql(
        "SELECT relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='appointments'",
      ),
    ).toBe("t");
  });

  it.skipIf(!HAS_PG)("the only policy is agency-scoped for both read and write", () => {
    const rows = sql(
      "SELECT policyname||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public' AND tablename='appointments'",
    )
      .split("\n")
      .filter(Boolean);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("ALL");
    expect(rows[0]).toContain("agency_id = private.current_agency_id()");
    // Both USING and WITH CHECK carry the tenant predicate.
    expect(rows[0]!.split("|").filter((p) => p.includes("current_agency_id"))).toHaveLength(2);
  });

  it.skipIf(!HAS_PG)("anonymous visitors have no privileges at all", () => {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(sql(`SELECT has_table_privilege('anon','public.appointments','${priv}')`)).toBe("f");
    }
  });

  it.skipIf(!HAS_PG)("authenticated members can use the table through RLS", () => {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(sql(`SELECT has_table_privilege('authenticated','public.appointments','${priv}')`)).toBe(
        "t",
      );
    }
  });

  it.skipIf(!HAS_PG)("agency_id defaults server-side so a client cannot forge it", () => {
    expect(
      sql(
        "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='agency_id'",
      ),
    ).toContain("current_agency_id()");
  });

  it.skipIf(!HAS_PG)("database constraints enforce the state model and time range", () => {
    const checks = sql(
      "SELECT conname FROM pg_constraint WHERE conrelid='public.appointments'::regclass AND contype='c'",
    );
    expect(checks).toContain("appointments_status_check");
    expect(checks).toContain("appointments_time_range_check");
  });
});
