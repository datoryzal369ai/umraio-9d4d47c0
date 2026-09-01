import { describe, expect, it } from "vitest";

import {
  gregorianToHijri,
  getIslamicContext,
  getAgencyIslamicContext,
  findHijriDateInYear,
} from "@/lib/context/hijri.core";
import {
  getPublicHolidays,
  isPublicHoliday,
  getAgencyHolidayStatus,
} from "@/lib/context/holidays.core";
import { SCHOOL_HOLIDAYS_STATUS } from "@/lib/context/holidays.data";
import { buildCalendarContextLines } from "@/lib/context/calendar-context.core";
import { buildCurrentContextBlock } from "@/lib/context/realtime-context.core";

// Fixed instant: Tuesday 2026-09-01 01:30 UTC === 09:30 Kuala Lumpur.
const NOW = new Date("2026-09-01T01:30:00.000Z");

describe("phase 2 — hijri conversion", () => {
  it("converts a known reference date deterministically", () => {
    const h = gregorianToHijri("2026-09-01");
    expect(h.year).toBe(1448);
    expect(h.month).toBe(3);
    expect(h.day).toBe(19);
    expect(h.monthName).toBe("Rabi al-Awwal");
    expect(h.formatted).toBe("19 Rabi al-Awwal 1448 AH");
  });

  it("marks provenance and moon-sighting uncertainty", () => {
    const h = gregorianToHijri("2026-09-01");
    expect(["UMM_AL_QURA", "TABULAR_CIVIL"]).toContain(h.method);
    expect(h.subjectToMoonSighting).toBe(true);
  });

  it("identifies Hijri month boundaries", () => {
    const start = findHijriDateInYear(1448, 9, 1);
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dayBefore = new Date(Date.parse(`${start}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(gregorianToHijri(start!).month).toBe(9);
    expect(gregorianToHijri(start!).day).toBe(1);
    expect(gregorianToHijri(dayBefore).month).toBe(8);
  });

  it("identifies Ramadan and computes days until Ramadan", () => {
    const ramadanStart = findHijriDateInYear(1448, 9, 1)!;
    expect(getIslamicContext(ramadanStart).isRamadan).toBe(true);
    expect(getIslamicContext(ramadanStart).daysUntilRamadan).toBe(0);

    const before = getIslamicContext("2026-09-01");
    expect(before.isRamadan).toBe(false);
    expect(before.daysUntilRamadan).toBeGreaterThan(0);
    expect(before.nextRamadanStart).toBe(ramadanStart);
  });

  it("identifies the Hajj season months", () => {
    const dhulHijjah = findHijriDateInYear(1448, 12, 5)!;
    const ctx = getIslamicContext(dhulHijjah);
    expect(ctx.isHajjSeason).toBe(true);
    expect(ctx.hijri.monthName).toBe("Dhul Hijjah");
  });

  it("derives from the agency timezone, never a client clock", () => {
    const late = new Date("2026-09-01T17:00:00.000Z"); // already 2026-09-02 in MY
    expect(getAgencyIslamicContext("Asia/Kuala_Lumpur", late).hijri.day).toBe(
      gregorianToHijri("2026-09-02").day,
    );
    expect(getAgencyIslamicContext("UTC", late).hijri.day).toBe(
      gregorianToHijri("2026-09-01").day,
    );
    // Invalid/unknown zone falls back to the platform default, not the client's.
    expect(getAgencyIslamicContext("Mars/Olympus", NOW).hijri.formatted).toBe(
      gregorianToHijri("2026-09-01").formatted,
    );
  });
});

describe("phase 2 — public holidays", () => {
  it("returns curated Malaysian holidays with provenance and status", () => {
    const res = getPublicHolidays(2026, "MY");
    expect(res.available).toBe(true);
    if (!res.available) return;
    const national = res.holidays.find((h) => h.date === "2026-08-31");
    expect(national).toMatchObject({
      name: "National Day (Hari Kebangsaan)",
      country: "MY",
      scope: "NATIONAL",
      status: "CONFIRMED",
    });
    expect(national!.source).toContain("UMRAIO curated dataset");
    expect(national!.datasetVersion).toBeTruthy();
  });

  it("marks Hijri-derived holidays as subject to official announcement", () => {
    const res = getPublicHolidays(2026, "MY");
    if (!res.available) throw new Error("expected data");
    const raya = res.holidays.filter((h) => h.name.startsWith("Hari Raya"));
    expect(raya.length).toBeGreaterThan(0);
    for (const h of raya) expect(h.status).toBe("CALCULATED_SUBJECT_TO_ANNOUNCEMENT");
  });

  it("exposes regional holidays only when the region matches", () => {
    const kl = getPublicHolidays(2026, "MY", "Kuala Lumpur");
    const penang = getPublicHolidays(2026, "MY", "Penang");
    if (!kl.available || !penang.available) throw new Error("expected data");
    expect(kl.holidays.some((h) => h.name === "Federal Territory Day")).toBe(true);
    expect(penang.holidays.some((h) => h.name === "Federal Territory Day")).toBe(false);
  });

  it("detects a non-holiday date without inventing one", () => {
    const check = isPublicHoliday("2026-09-01", "MY");
    expect(check).toMatchObject({ known: true, isHoliday: false });
  });

  it("returns an honest unavailable state for unsupported years and countries", () => {
    expect(getPublicHolidays(2099, "MY")).toMatchObject({
      available: false,
      reason: "UNSUPPORTED_YEAR",
    });
    expect(getPublicHolidays(2026, "SG")).toMatchObject({
      available: false,
      reason: "UNSUPPORTED_COUNTRY",
    });
    expect(isPublicHoliday("2099-01-01", "MY")).toMatchObject({ known: false });
  });

  it("does not fabricate holidays outside the curated dataset", () => {
    const res = getPublicHolidays(2026, "MY");
    if (!res.available) throw new Error("expected data");
    // Nothing on an arbitrary ordinary weekday.
    expect(res.holidays.some((h) => h.date === "2026-03-11")).toBe(false);
    // School holidays are explicitly out of scope for this phase.
    expect(SCHOOL_HOLIDAYS_STATUS).toBe("FUTURE / EXTERNAL DATASET");
  });

  it("resolves holiday status in the agency timezone", () => {
    const nyEve = new Date("2025-12-31T17:00:00.000Z"); // 2026-01-01 in MY
    expect(getAgencyHolidayStatus("Asia/Kuala_Lumpur", nyEve)).toMatchObject({
      known: true,
      isHoliday: true,
    });
  });
});

describe("phase 2 — context block integration", () => {
  it("appends compact Hijri and holiday lines", () => {
    const lines = buildCalendarContextLines({ timezone: "Asia/Kuala_Lumpur", now: NOW });
    const block = buildCurrentContextBlock({
      timezone: "Asia/Kuala_Lumpur",
      now: NOW,
      extraLines: lines,
    });
    expect(block).toContain("CURRENT DATE: 2026-09-01");
    expect(block).toContain("HIJRI DATE: 19 Rabi al-Awwal 1448 AH");
    expect(block).toContain("ISLAMIC CALENDAR CONTEXT:");
    expect(block).toContain("PUBLIC HOLIDAY: No");
    expect(block).toContain("CALENDAR TRUTH RULES:");
  });

  it("keeps v0 output unchanged when no calendar lines are supplied", () => {
    const block = buildCurrentContextBlock({ timezone: "Asia/Kuala_Lumpur", now: NOW });
    expect(block).not.toContain("HIJRI DATE");
    expect(block).toContain("BUSINESS STATUS: UNKNOWN");
  });

  it("never accepts a client timezone or client clock", () => {
    const lines = buildCalendarContextLines({ timezone: "Asia/Kuala_Lumpur", now: NOW }).join("\n");
    expect(lines).not.toContain("America/New_York");
    expect(lines).not.toContain("2001");
  });
});
