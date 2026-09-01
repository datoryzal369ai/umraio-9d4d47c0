/**
 * UMRAIO® — PUBLIC HOLIDAY CONTEXT (Phase 2, deterministic core).
 *
 * Reads ONLY the curated, versioned dataset plus the deterministic Hijri core.
 * Never invents holidays; unsupported years return an explicit unavailable
 * result so the AI can answer honestly instead of guessing.
 */

import { findHijriDateInYear, gregorianToHijri } from "./hijri.core";
import { getAgencyLocalDateTime } from "./realtime-context.core";
import {
  FIXED_DATE_HOLIDAYS,
  HIJRI_DERIVED_HOLIDAYS,
  HOLIDAY_DATASET_SOURCE,
  HOLIDAY_DATASET_VERSION,
  SUPPORTED_YEARS,
  type PublicHoliday,
} from "./holidays.data";

export type { PublicHoliday } from "./holidays.data";

export type PublicHolidayLookup =
  | {
      available: true;
      year: number;
      country: string;
      region?: string;
      holidays: PublicHoliday[];
      datasetVersion: string;
      source: string;
    }
  | {
      available: false;
      year: number;
      country: string;
      region?: string;
      reason: "UNSUPPORTED_COUNTRY" | "UNSUPPORTED_YEAR";
      datasetVersion: string;
      source: string;
    };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Curated public-holiday lookup.
 * `region` filters regional holidays in; national holidays are always returned.
 */
export function getPublicHolidays(
  year: number,
  country: string,
  region?: string,
): PublicHolidayLookup {
  const cc = (country ?? "").trim().toUpperCase();
  const base = { year, country: cc, datasetVersion: HOLIDAY_DATASET_VERSION, source: HOLIDAY_DATASET_SOURCE, ...(region ? { region } : {}) };

  const fixed = FIXED_DATE_HOLIDAYS[cc];
  const years = SUPPORTED_YEARS[cc];
  if (!fixed || !years) return { available: false, reason: "UNSUPPORTED_COUNTRY", ...base };
  if (!years.includes(year)) return { available: false, reason: "UNSUPPORTED_YEAR", ...base };

  const holidays: PublicHoliday[] = [];

  for (const h of fixed) {
    if (h.region && region && h.region !== region) continue;
    holidays.push({
      date: `${year}-${pad(h.month)}-${pad(h.day)}`,
      name: h.name,
      country: cc,
      ...(h.region ? { region: h.region } : {}),
      scope: h.region ? "REGIONAL" : "NATIONAL",
      source: HOLIDAY_DATASET_SOURCE,
      status: "CONFIRMED",
      datasetVersion: HOLIDAY_DATASET_VERSION,
    });
  }

  // Hijri-derived holidays: two candidate Hijri years can fall in one Gregorian year.
  const hijriYears = new Set([
    gregorianToHijri(`${year}-01-01`).year,
    gregorianToHijri(`${year}-12-31`).year,
  ]);
  for (const hy of hijriYears) {
    for (const h of HIJRI_DERIVED_HOLIDAYS) {
      const date = findHijriDateInYear(hy, h.hijriMonth, h.hijriDay);
      if (!date || !date.startsWith(`${year}-`)) continue;
      if (holidays.some((x) => x.date === date && x.name === h.name)) continue;
      holidays.push({
        date,
        name: h.name,
        country: cc,
        scope: "NATIONAL",
        source: `${HOLIDAY_DATASET_SOURCE} + calculated Hijri calendar (Umm al-Qura)`,
        status: "CALCULATED_SUBJECT_TO_ANNOUNCEMENT",
        datasetVersion: HOLIDAY_DATASET_VERSION,
      });
    }
  }

  holidays.sort((a, b) => a.date.localeCompare(b.date));
  return { available: true, holidays, ...base };
}

export type HolidayCheck =
  | { known: true; isHoliday: false; date: string; country: string; region?: string }
  | { known: true; isHoliday: true; date: string; country: string; region?: string; holidays: PublicHoliday[] }
  | { known: false; date: string; country: string; region?: string; reason: "UNSUPPORTED_COUNTRY" | "UNSUPPORTED_YEAR" };

/** Honest holiday check: unsupported years return `known: false`, never false-negative. */
export function isPublicHoliday(dateIso: string, country: string, region?: string): HolidayCheck {
  const year = Number(dateIso.slice(0, 4));
  const lookup = getPublicHolidays(year, country, region);
  const cc = (country ?? "").trim().toUpperCase();
  const base = { date: dateIso, country: cc, ...(region ? { region } : {}) };
  if (!lookup.available) return { known: false, reason: lookup.reason, ...base };
  const matches = lookup.holidays.filter((h) => h.date === dateIso);
  return matches.length
    ? { known: true, isHoliday: true, holidays: matches, ...base }
    : { known: true, isHoliday: false, ...base };
}

/** Agency-local holiday check from an authoritative server instant. */
export function getAgencyHolidayStatus(
  timezone?: string | null,
  now: Date = new Date(),
  country = "MY",
  region?: string,
): HolidayCheck {
  return isPublicHoliday(getAgencyLocalDateTime(timezone, now).date, country, region);
}
