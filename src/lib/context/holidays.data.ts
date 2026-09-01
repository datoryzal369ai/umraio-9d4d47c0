/**
 * UMRAIO® — CURATED PUBLIC HOLIDAY DATASET (Phase 2).
 *
 * Versioned, hand-curated dataset. No scraping, no runtime network calls, no
 * model-generated dates. Only fixed-date statutory holidays are stored here;
 * lunar/Hijri-dependent holidays are DERIVED at lookup time from the
 * deterministic Hijri core and always carry a non-confirmed status.
 *
 * Annual maintenance: add a new year entry to FIXED_DATE_HOLIDAYS and extend
 * SUPPORTED_YEARS. Application logic never changes.
 */

export const HOLIDAY_DATASET_VERSION = "2026.09-my-v1";

export const HOLIDAY_DATASET_SOURCE =
  "UMRAIO curated dataset (Malaysia fixed-date statutory public holidays)";

export type HolidayStatus =
  /** Fixed statutory date, stable year to year. */
  | "CONFIRMED"
  /** Calculated from the Hijri calendar; official date may shift by a day. */
  | "CALCULATED_SUBJECT_TO_ANNOUNCEMENT";

export type HolidayScope = "NATIONAL" | "REGIONAL";

export type PublicHoliday = {
  /** YYYY-MM-DD in the country's local calendar. */
  date: string;
  name: string;
  country: string;
  /** Present only for regional holidays. */
  region?: string;
  scope: HolidayScope;
  source: string;
  status: HolidayStatus;
  datasetVersion: string;
};

/** Years for which curated Malaysian fixed-date data exists. */
export const SUPPORTED_YEARS: Readonly<Record<string, readonly number[]>> = {
  MY: [2026, 2027],
};

type FixedHoliday = { month: number; day: number; name: string; region?: string };

/** Fixed-date Malaysian public holidays (same Gregorian date every year). */
export const FIXED_DATE_HOLIDAYS: Readonly<Record<string, readonly FixedHoliday[]>> = {
  MY: [
    { month: 1, day: 1, name: "New Year's Day" },
    { month: 2, day: 1, name: "Federal Territory Day", region: "Kuala Lumpur" },
    { month: 5, day: 1, name: "Labour Day" },
    { month: 8, day: 31, name: "National Day (Hari Kebangsaan)" },
    { month: 9, day: 16, name: "Malaysia Day (Hari Malaysia)" },
    { month: 12, day: 25, name: "Christmas Day" },
  ],
};

/**
 * Hijri-dependent Malaysian public holidays, expressed as Hijri month/day.
 * Derived at lookup time — never hardcoded as Gregorian dates.
 */
export const HIJRI_DERIVED_HOLIDAYS: readonly {
  hijriMonth: number;
  hijriDay: number;
  name: string;
}[] = [
  { hijriMonth: 1, hijriDay: 1, name: "Awal Muharram (Maal Hijrah)" },
  { hijriMonth: 3, hijriDay: 12, name: "Maulidur Rasul" },
  { hijriMonth: 10, hijriDay: 1, name: "Hari Raya Aidilfitri" },
  { hijriMonth: 10, hijriDay: 2, name: "Hari Raya Aidilfitri (second day)" },
  { hijriMonth: 12, hijriDay: 10, name: "Hari Raya Aidiladha" },
];

/**
 * School holidays are intentionally NOT implemented in this phase.
 * FUTURE / EXTERNAL DATASET — requires an authoritative KPM source.
 */
export const SCHOOL_HOLIDAYS_STATUS = "FUTURE / EXTERNAL DATASET" as const;
