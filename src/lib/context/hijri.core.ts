/**
 * UMRAIO® — HIJRI CONTEXT (Phase 2, deterministic core).
 *
 * Extends REAL-TIME CONTEXT v0 with Hijri calendar awareness.
 *
 * Authority rules:
 *  - Conversion is CALCULATED from the runtime ICU Umm al-Qura calendar
 *    (`islamic-umalqura`), never from model memory.
 *  - If the runtime cannot provide Umm al-Qura, the module falls back to the
 *    deterministic tabular civil Islamic calendar and downgrades the method.
 *  - Any date that in practice depends on moon sighting / official
 *    announcement is returned as CALCULATED + `subjectToMoonSighting: true`.
 *    It is NEVER presented as officially confirmed.
 */

import { getAgencyLocalDateTime } from "./realtime-context.core";

export const HIJRI_MONTHS = [
  "Muharram",
  "Safar",
  "Rabi al-Awwal",
  "Rabi al-Thani",
  "Jumada al-Awwal",
  "Jumada al-Thani",
  "Rajab",
  "Shaban",
  "Ramadan",
  "Shawwal",
  "Dhul Qadah",
  "Dhul Hijjah",
] as const;

export type HijriMonthName = (typeof HIJRI_MONTHS)[number];

export type HijriMethod = "UMM_AL_QURA" | "TABULAR_CIVIL";

export type HijriDate = {
  year: number;
  month: number; // 1-12
  monthName: HijriMonthName;
  day: number;
  /** Provenance of the conversion. */
  method: HijriMethod;
  /** Always true: calculated calendars can differ from official announcements. */
  subjectToMoonSighting: boolean;
  formatted: string;
};

/* --------------------------- conversion primitives -------------------------- */

let cachedFormatter: Intl.DateTimeFormat | null | undefined;

function ummAlQuraFormatter(): Intl.DateTimeFormat | null {
  if (cachedFormatter !== undefined) return cachedFormatter;
  try {
    const fmt = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    cachedFormatter = fmt.resolvedOptions().calendar === "islamic-umalqura" ? fmt : null;
  } catch {
    cachedFormatter = null;
  }
  return cachedFormatter;
}

function toJulianDay(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * mm + 2) / 5) +
    365 * yy +
    Math.floor(yy / 4) -
    Math.floor(yy / 100) +
    Math.floor(yy / 400) -
    32045
  );
}

/** Deterministic tabular civil Islamic calendar (fallback only). */
function tabularHijri(y: number, m: number, d: number): { year: number; month: number; day: number } {
  const jd = toJulianDay(y, m, d);
  const days = jd - 1948440 + 10632;
  const n = Math.floor((days - 1) / 10631);
  const rest1 = days - 10631 * n + 354;
  const j =
    Math.floor((10985 - rest1) / 5316) * Math.floor((50 * rest1) / 17719) +
    Math.floor(rest1 / 5670) * Math.floor((43 * rest1) / 15238);
  const rest2 =
    rest1 -
    Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) -
    Math.floor(j / 16) * Math.floor((15238 * j) / 43) +
    29;
  const month = Math.floor((24 * rest2) / 709);
  const day = rest2 - Math.floor((709 * month) / 24);
  const year = 30 * n + j - 30;
  return { year, month, day };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Converts an agency-local `YYYY-MM-DD` calendar date to a Hijri date. */
export function gregorianToHijri(dateIso: string): HijriDate {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const fmt = ummAlQuraFormatter();
  let year: number;
  let month: number;
  let day: number;
  let method: HijriMethod;

  if (fmt) {
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(Date.UTC(y, m - 1, d, 12)))) map[p.type] = p.value;
    year = Number(map["year"]);
    month = Number(map["month"]);
    day = Number(map["day"]);
    method = "UMM_AL_QURA";
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      const t = tabularHijri(y, m, d);
      year = t.year;
      month = t.month;
      day = t.day;
      method = "TABULAR_CIVIL";
    }
  } else {
    const t = tabularHijri(y, m, d);
    year = t.year;
    month = t.month;
    day = t.day;
    method = "TABULAR_CIVIL";
  }

  const monthName = HIJRI_MONTHS[month - 1] ?? HIJRI_MONTHS[0]!;
  return {
    year,
    month,
    monthName,
    day,
    method,
    subjectToMoonSighting: true,
    formatted: `${day} ${monthName} ${year} AH`,
  };
}

function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetweenIso(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = fromIso.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = toIso.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/**
 * First Gregorian date on or after `fromDateIso` whose Hijri day/month match.
 * Bounded scan (approximate jump + local search) — deterministic, no network.
 * Returns null when it cannot be determined within the search window.
 */
export function findNextHijriDate(
  hijriMonth: number,
  hijriDay: number,
  fromDateIso: string,
  maxDays = 800,
): string | null {
  for (let i = 0; i <= maxDays; i += 1) {
    const candidate = addDaysIso(fromDateIso, i);
    const h = gregorianToHijri(candidate);
    if (h.month === hijriMonth && h.day === hijriDay) return candidate;
  }
  return null;
}

/** Gregorian date of `hijriDay/hijriMonth` in a specific Hijri year, or null. */
export function findHijriDateInYear(
  hijriYear: number,
  hijriMonth: number,
  hijriDay: number,
): string | null {
  // Approximate Gregorian anchor for the start of the Hijri year.
  const approxGregYear = Math.floor(hijriYear - hijriYear / 33.7 + 622);
  let cursor = `${approxGregYear - 1}-01-01`;
  for (let i = 0; i <= 900; i += 1) {
    const candidate = addDaysIso(cursor, i);
    const h = gregorianToHijri(candidate);
    if (h.year === hijriYear && h.month === hijriMonth && h.day === hijriDay) return candidate;
    if (h.year > hijriYear) return null;
  }
  cursor = "";
  return null;
}

/* ----------------------------- Islamic context ----------------------------- */

export type IslamicPeriod =
  | "RAMADAN"
  | "EID_AL_FITR_PERIOD"
  | "HAJJ_SEASON"
  | "EID_AL_ADHA_PERIOD"
  | "MUHARRAM"
  | "RAJAB"
  | "SHABAN"
  | "NORMAL";

export type IslamicContext = {
  hijri: HijriDate;
  period: IslamicPeriod;
  label: string;
  isRamadan: boolean;
  isHajjSeason: boolean;
  /** Days until 1 Ramadan (0 when Ramadan has started). Null if undeterminable. */
  daysUntilRamadan: number | null;
  /** Calculated (not officially announced) start of the next/current Ramadan. */
  nextRamadanStart: string | null;
  method: HijriMethod;
  subjectToMoonSighting: boolean;
};

export function getIslamicContext(dateIso: string): IslamicContext {
  const hijri = gregorianToHijri(dateIso);
  let period: IslamicPeriod = "NORMAL";
  if (hijri.month === 9) period = "RAMADAN";
  else if (hijri.month === 10 && hijri.day <= 3) period = "EID_AL_FITR_PERIOD";
  else if (hijri.month === 12 && hijri.day >= 8 && hijri.day <= 13) period = "EID_AL_ADHA_PERIOD";
  else if (hijri.month === 11 || hijri.month === 12) period = "HAJJ_SEASON";
  else if (hijri.month === 1) period = "MUHARRAM";
  else if (hijri.month === 7) period = "RAJAB";
  else if (hijri.month === 8) period = "SHABAN";

  const isRamadan = hijri.month === 9;
  const isHajjSeason = hijri.month === 11 || hijri.month === 12;

  const nextRamadanStart = isRamadan
    ? findHijriDateInYear(hijri.year, 9, 1)
    : findNextHijriDate(9, 1, dateIso);
  const daysUntilRamadan = isRamadan
    ? 0
    : nextRamadanStart
      ? daysBetweenIso(dateIso, nextRamadanStart)
      : null;

  const labels: Record<IslamicPeriod, string> = {
    RAMADAN: "Ramadan",
    EID_AL_FITR_PERIOD: "Syawal / Aidilfitri period",
    HAJJ_SEASON: "Hajj season",
    EID_AL_ADHA_PERIOD: "Hajj season / Aidiladha period",
    MUHARRAM: "Muharram (new Hijri year)",
    RAJAB: "Rajab",
    SHABAN: "Shaban (pre-Ramadan)",
    NORMAL: "Normal period",
  };

  return {
    hijri,
    period,
    label: labels[period],
    isRamadan,
    isHajjSeason,
    daysUntilRamadan,
    nextRamadanStart,
    method: hijri.method,
    subjectToMoonSighting: true,
  };
}

/** Agency-local Islamic context from an authoritative server instant. */
export function getAgencyIslamicContext(
  timezone?: string | null,
  now: Date = new Date(),
): IslamicContext {
  return getIslamicContext(getAgencyLocalDateTime(timezone, now).date);
}
