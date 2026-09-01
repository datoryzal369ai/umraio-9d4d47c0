/**
 * UMRAIO® — CALENDAR CONTEXT LINES (Phase 2).
 *
 * Composes the compact Hijri + public-holiday lines appended to the
 * REAL-TIME CONTEXT block. Deterministic, server-clock driven, no client input.
 */

import { getAgencyHolidayStatus } from "./holidays.core";
import { getAgencyIslamicContext } from "./hijri.core";

export function buildCalendarContextLines(input: {
  timezone?: string | null;
  now?: Date;
  country?: string;
  region?: string;
}): string[] {
  const now = input.now ?? new Date();
  const islamic = getAgencyIslamicContext(input.timezone, now);
  const holiday = getAgencyHolidayStatus(input.timezone, now, input.country ?? "MY", input.region);

  const lines: string[] = [
    `HIJRI DATE: ${islamic.hijri.formatted} (calculated, ${islamic.method === "UMM_AL_QURA" ? "Umm al-Qura" : "tabular civil"}; official date may differ by a day)`,
    `ISLAMIC CALENDAR CONTEXT: ${islamic.label}${
      islamic.isRamadan
        ? ""
        : islamic.daysUntilRamadan !== null
          ? ` — approx. ${islamic.daysUntilRamadan} days until the calculated start of Ramadan (${islamic.nextRamadanStart})`
          : " — next Ramadan start could not be determined"
    }`,
  ];

  if (holiday.known) {
    lines.push(
      holiday.isHoliday
        ? `PUBLIC HOLIDAY: Yes — ${holiday.holidays.map((h) => `${h.name}${h.status === "CALCULATED_SUBJECT_TO_ANNOUNCEMENT" ? " (calculated, subject to official announcement)" : ""}`).join("; ")}`
        : "PUBLIC HOLIDAY: No",
    );
  } else {
    lines.push(
      `PUBLIC HOLIDAY: UNKNOWN — no curated holiday data for this date (${holiday.reason}). Say you cannot confirm instead of guessing.`,
    );
  }

  lines.push(
    "CALENDAR TRUTH RULES: Hijri dates and Islamic/lunar holidays above are CALCULATED and may shift by one day pending official moon sighting or government announcement — always say so. Never state an Islamic date, Ramadan start, Raya date or public holiday that is not in this block; if it is missing or UNKNOWN, say it needs confirmation. School-holiday data is not available.",
  );

  return lines;
}
