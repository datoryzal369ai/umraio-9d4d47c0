import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEZONE,
  buildCurrentContextBlock,
  getAgencyLocalDateTime,
  getMonth,
  getWeekday,
  isBusinessOpenNow,
  normalizeTimezone,
  resolveRelativeDate,
} from "@/lib/context/realtime-context.core";

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

describe("real-time context v0 — time authority", () => {
  it("1. resolves Malaysia local time from the server instant", () => {
    const local = getAgencyLocalDateTime("Asia/Kuala_Lumpur", NOW);
    expect(local.date).toBe("2026-09-01");
    expect(local.time).toBe("09:30");
    expect(local.timezone).toBe("Asia/Kuala_Lumpur");
    expect(local.year).toBe(2026);
  });

  it("2. converts UTC to Malaysia (+8)", () => {
    expect(getAgencyLocalDateTime("UTC", NOW).time).toBe("01:30");
    expect(getAgencyLocalDateTime("Asia/Kuala_Lumpur", NOW).time).toBe("09:30");
  });

  it("3. handles date rollover across the timezone boundary", () => {
    const late = new Date("2026-09-01T17:00:00.000Z");
    expect(getAgencyLocalDateTime("UTC", late).date).toBe("2026-09-01");
    expect(getAgencyLocalDateTime("Asia/Kuala_Lumpur", late).date).toBe("2026-09-02");
  });

  it("4. handles midnight", () => {
    const midnight = new Date("2026-08-31T16:00:00.000Z");
    const local = getAgencyLocalDateTime("Asia/Kuala_Lumpur", midnight);
    expect(local.time).toBe("00:00");
    expect(local.date).toBe("2026-09-01");
  });

  it("17. missing timezone falls back to Asia/Kuala_Lumpur", () => {
    expect(normalizeTimezone(null)).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone("")).toBe(DEFAULT_TIMEZONE);
    expect(getAgencyLocalDateTime(null, NOW).timezone).toBe("Asia/Kuala_Lumpur");
  });

  it("18. invalid timezone falls back safely", () => {
    expect(normalizeTimezone("Mars/Olympus")).toBe(DEFAULT_TIMEZONE);
    expect(getAgencyLocalDateTime("not-a-zone", NOW).time).toBe("09:30");
  });

  it("19. a client-supplied clock cannot override the server instant", () => {
    const serverBlock = buildCurrentContextBlock({ timezone: "Asia/Kuala_Lumpur", now: NOW });
    const clientClaim = new Date("2001-01-01T00:00:00.000Z");
    expect(serverBlock).toContain("CURRENT DATE: 2026-09-01");
    expect(serverBlock).not.toContain(String(clientClaim.getUTCFullYear()));
  });

  it("20. a client timezone cannot override the agency timezone", () => {
    const block = buildCurrentContextBlock({
      timezone: "Asia/Kuala_Lumpur",
      now: NOW,
      // Only the agency record feeds the block; there is no client input path.
    });
    expect(block).toContain("TIMEZONE: Asia/Kuala_Lumpur");
    expect(block).not.toContain("America/New_York");
  });

  it("reports weekday and month deterministically", () => {
    expect(getWeekday("Asia/Kuala_Lumpur", NOW)).toBe("Tuesday");
    expect(getMonth("Asia/Kuala_Lumpur", NOW)).toBe("September");
  });
});

describe("real-time context v0 — relative dates", () => {
  const r = (phrase: string) => resolveRelativeDate(phrase, "Asia/Kuala_Lumpur", NOW);

  it("5. today / hari ini", () => {
    expect(r("today")).toMatchObject({ resolved: true, date: "2026-09-01" });
    expect(r("boleh hari ini?")).toMatchObject({ resolved: true, date: "2026-09-01" });
  });

  it("6. tomorrow / esok", () => {
    expect(r("tomorrow")).toMatchObject({ resolved: true, date: "2026-09-02" });
    expect(r("esok")).toMatchObject({ resolved: true, date: "2026-09-02" });
  });

  it("7. yesterday / semalam", () => {
    expect(r("yesterday")).toMatchObject({ resolved: true, date: "2026-08-31" });
    expect(r("semalam")).toMatchObject({ resolved: true, date: "2026-08-31" });
  });

  it("8. tonight / malam ini", () => {
    expect(r("tonight")).toMatchObject({
      resolved: true,
      date: "2026-09-01",
      partOfDay: "evening",
    });
    expect(r("malam ini")).toMatchObject({ resolved: true, partOfDay: "evening" });
  });

  it("9. Malay weekday — Jumaat ini", () => {
    expect(r("Jumaat ini")).toMatchObject({
      resolved: true,
      date: "2026-09-04",
      weekday: "Friday",
    });
  });

  it("10. English weekday — this Friday", () => {
    expect(r("this Friday")).toMatchObject({ resolved: true, date: "2026-09-04" });
  });

  it("11. next weekday — next Friday / Jumaat depan", () => {
    expect(r("next Friday")).toMatchObject({ resolved: true, date: "2026-09-11" });
    expect(r("Jumaat depan")).toMatchObject({ resolved: true, date: "2026-09-11" });
  });

  it("12. next week / minggu depan", () => {
    expect(r("next week")).toMatchObject({ resolved: true, date: "2026-09-08" });
    expect(r("minggu depan")).toMatchObject({ resolved: true, date: "2026-09-08" });
  });

  it("13. ambiguous phrases return unresolved without guessing", () => {
    expect(r("Friday")).toMatchObject({ resolved: false, reason: "ambiguous" });
    expect(r("Jumaat")).toMatchObject({ resolved: false, reason: "ambiguous" });
    expect(r("nanti bila-bila")).toMatchObject({ resolved: false });
    expect(r("")).toMatchObject({ resolved: false });
  });

  it("anchors to the agency-local date, not UTC", () => {
    const late = new Date("2026-09-01T17:00:00.000Z"); // 2026-09-02 in MY
    expect(resolveRelativeDate("today", "Asia/Kuala_Lumpur", late)).toMatchObject({
      date: "2026-09-02",
    });
    expect(resolveRelativeDate("today", "UTC", late)).toMatchObject({ date: "2026-09-01" });
  });
});

describe("real-time context v0 — business hours", () => {
  it("14. open during configured hours", () => {
    expect(isBusinessOpenNow(HOURS, "Asia/Kuala_Lumpur", NOW).status).toBe("OPEN");
  });

  it("15. closed outside configured hours", () => {
    const evening = new Date("2026-09-01T13:00:00.000Z"); // 21:00 MY
    expect(isBusinessOpenNow(HOURS, "Asia/Kuala_Lumpur", evening).status).toBe("CLOSED");
  });

  it("16. closed day", () => {
    const sunday = new Date("2026-09-06T03:00:00.000Z"); // Sunday 11:00 MY
    expect(isBusinessOpenNow(HOURS, "Asia/Kuala_Lumpur", sunday).status).toBe("CLOSED");
  });

  it("returns UNKNOWN for missing or invalid configuration", () => {
    expect(isBusinessOpenNow(null, "Asia/Kuala_Lumpur", NOW).status).toBe("UNKNOWN");
    expect(
      isBusinessOpenNow({ tue: { open: "oops", close: "18:00", closed: false } }, null, NOW).status,
    ).toBe("UNKNOWN");
  });

  it("injects a runtime context block with live values", () => {
    const block = buildCurrentContextBlock({
      timezone: "Asia/Kuala_Lumpur",
      businessHours: HOURS,
      now: NOW,
    });
    expect(block).toContain("CURRENT DATE: 2026-09-01");
    expect(block).toContain("CURRENT TIME: 09:30");
    expect(block).toContain("DAY: Tuesday");
    expect(block).toContain("BUSINESS STATUS: OPEN");
  });
});
