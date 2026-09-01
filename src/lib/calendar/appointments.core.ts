/**
 * UMRAIO® — PHASE 3: INTERNAL CALENDAR + APPOINTMENT FOUNDATION (core).
 *
 * Deterministic, dependency-free appointment domain logic:
 *  - agency-local <-> UTC conversion (server-authoritative instants only)
 *  - business-hours aware availability windows
 *  - conflict detection against existing appointments
 *  - explicit UNRESOLVED outcomes instead of guessing
 *
 * Time authority is inherited from Real-Time Context v0
 * (src/lib/context/realtime-context.core.ts). This module never reads a
 * browser clock and never accepts a client-supplied timezone: callers pass
 * the agency timezone loaded from the agency record.
 *
 * FUTURE INTEGRATION: external providers (Google / Microsoft) would supply
 * additional `CalendarEvent[]` into these pure functions. No provider,
 * OAuth, sync or webhook exists in this phase by design.
 */

import {
  getAgencyLocalDateTime,
  isBusinessOpenNow,
  normalizeTimezone,
  resolveRelativeDate,
  type BusinessHoursConfig,
  type WeekdayName,
} from "@/lib/context/realtime-context.core";

export const APPOINTMENT_STATUSES = ["scheduled", "cancelled", "completed"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that occupy time on the calendar. */
export const BLOCKING_STATUSES: AppointmentStatus[] = ["scheduled", "completed"];

export type CalendarEvent = {
  id: string;
  title: string;
  /** Authoritative UTC ISO instant. */
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  leadId?: string | null;
};

export const DEFAULT_SLOT_INTERVAL_MINUTES = 30;
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 8 * 60;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export function isValidDateIso(date: unknown): date is string {
  if (typeof date !== "string" || !DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseHhMm(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function minutesToHhMm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Offset (ms) of the zone at a given instant: localWallClock - utc. */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) map[p.type] = p.value;
  const hour = map["hour"] === "24" ? 0 : Number(map["hour"]);
  const asUtc = Date.UTC(
    Number(map["year"]),
    Number(map["month"]) - 1,
    Number(map["day"]),
    hour,
    Number(map["minute"]),
    Number(map["second"]),
  );
  return asUtc - instant.getTime();
}

/**
 * Converts an agency-local wall clock (date + HH:mm) into the authoritative
 * UTC instant. Never trusts a client timezone: `timezone` comes from the
 * agency record and falls back to the platform default.
 */
export function zonedTimeToUtc(dateIso: string, hhmm: string, timezone?: string | null): Date | null {
  if (!isValidDateIso(dateIso)) return null;
  const minutes = parseHhMm(hhmm);
  if (minutes === null) return null;
  const tz = normalizeTimezone(timezone);
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let utc = naive - zoneOffsetMs(new Date(naive), tz);
  // One correction pass handles DST transitions in zones that observe them.
  utc = naive - zoneOffsetMs(new Date(utc), tz);
  return new Date(utc);
}

/** Agency-local calendar view of an authoritative instant. */
export function utcToAgencyLocal(instantIso: string, timezone?: string | null) {
  const local = getAgencyLocalDateTime(timezone, new Date(instantIso));
  return { date: local.date, time: local.time, weekday: local.weekday, timezone: local.timezone };
}

/* --------------------------------- validation -------------------------------- */

export type TimeRangeValidation =
  | { valid: true; startAt: string; endAt: string; durationMinutes: number }
  | { valid: false; reason: "invalid_start" | "invalid_end" | "end_before_start" | "duration_out_of_range" };

export function validateTimeRange(startAt: unknown, endAt: unknown): TimeRangeValidation {
  const start = typeof startAt === "string" ? new Date(startAt) : null;
  if (!start || Number.isNaN(start.getTime())) return { valid: false, reason: "invalid_start" };
  const end = typeof endAt === "string" ? new Date(endAt) : null;
  if (!end || Number.isNaN(end.getTime())) return { valid: false, reason: "invalid_end" };
  if (end.getTime() <= start.getTime()) return { valid: false, reason: "end_before_start" };
  const duration = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
    return { valid: false, reason: "duration_out_of_range" };
  }
  return { valid: true, startAt: start.toISOString(), endAt: end.toISOString(), durationMinutes: duration };
}

export function normalizeDuration(durationMinutes: unknown): number | null {
  const n = typeof durationMinutes === "number" ? durationMinutes : Number(durationMinutes);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_DURATION_MINUTES || rounded > MAX_DURATION_MINUTES) return null;
  return rounded;
}

/* -------------------------------- conflicts --------------------------------- */

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Cancelled appointments never block a slot. */
export function blockingEvents(events: CalendarEvent[]): CalendarEvent[] {
  return (events ?? []).filter((e) => BLOCKING_STATUSES.includes(e.status));
}

export function findConflicts(
  events: CalendarEvent[],
  startAt: string,
  endAt: string,
): CalendarEvent[] {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  return blockingEvents(events).filter((e) =>
    rangesOverlap(start, end, new Date(e.startAt).getTime(), new Date(e.endAt).getTime()),
  );
}

export function hasConflict(events: CalendarEvent[], startAt: string, endAt: string): boolean {
  return findConflicts(events, startAt, endAt).length > 0;
}

/* -------------------------------- availability ------------------------------- */

export type AvailabilitySlot = { startAt: string; endAt: string; localStart: string; localEnd: string };

export type AvailabilityResult =
  | {
      status: "ok";
      date: string;
      timezone: string;
      durationMinutes: number;
      slots: AvailabilitySlot[];
    }
  | {
      status: "unresolved";
      reason: "missing_duration" | "invalid_duration" | "invalid_date" | "business_hours_unknown";
      timezone: string;
    }
  | { status: "closed"; date: string; timezone: string; weekday: WeekdayName };

export type AvailabilityInput = {
  date: string;
  timezone?: string | null;
  businessHours: BusinessHoursConfig;
  durationMinutes?: number | null;
  events?: CalendarEvent[];
  slotIntervalMinutes?: number;
  /** Server clock: slots already in the past are excluded. */
  now?: Date;
};

/**
 * Read-only availability computation. Returns explicit UNRESOLVED outcomes
 * (e.g. missing duration) rather than inventing defaults.
 */
export function getAvailableSlots(input: AvailabilityInput): AvailabilityResult {
  const tz = normalizeTimezone(input.timezone);
  if (input.durationMinutes === undefined || input.durationMinutes === null) {
    return { status: "unresolved", reason: "missing_duration", timezone: tz };
  }
  const duration = normalizeDuration(input.durationMinutes);
  if (duration === null) return { status: "unresolved", reason: "invalid_duration", timezone: tz };
  if (!isValidDateIso(input.date)) {
    return { status: "unresolved", reason: "invalid_date", timezone: tz };
  }

  const noon = zonedTimeToUtc(input.date, "12:00", tz)!;
  const local = getAgencyLocalDateTime(tz, noon);
  const dayKey = DAY_KEYS[local.weekdayIndex]!;
  const hours = input.businessHours && typeof input.businessHours === "object"
    ? input.businessHours[dayKey]
    : null;
  if (!hours || typeof hours !== "object") {
    return { status: "unresolved", reason: "business_hours_unknown", timezone: tz };
  }
  if (hours.closed === true) {
    return { status: "closed", date: input.date, timezone: tz, weekday: local.weekday };
  }
  const open = parseHhMm(hours.open);
  const close = parseHhMm(hours.close);
  if (open === null || close === null || close <= open) {
    return { status: "unresolved", reason: "business_hours_unknown", timezone: tz };
  }

  const interval = Math.max(5, Math.round(input.slotIntervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES));
  const nowMs = (input.now ?? new Date()).getTime();
  const events = blockingEvents(input.events ?? []);
  const slots: AvailabilitySlot[] = [];

  for (let minute = open; minute + duration <= close; minute += interval) {
    const start = zonedTimeToUtc(input.date, minutesToHhMm(minute), tz);
    if (!start) continue;
    const end = new Date(start.getTime() + duration * 60_000);
    if (start.getTime() < nowMs) continue;
    const conflict = events.some((e) =>
      rangesOverlap(
        start.getTime(),
        end.getTime(),
        new Date(e.startAt).getTime(),
        new Date(e.endAt).getTime(),
      ),
    );
    if (conflict) continue;
    slots.push({
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      localStart: minutesToHhMm(minute),
      localEnd: minutesToHhMm(minute + duration),
    });
  }

  return { status: "ok", date: input.date, timezone: tz, durationMinutes: duration, slots };
}

/* --------------------------- conversational resolution ----------------------- */

export type RequestedSlotResult =
  | {
      status: "available";
      date: string;
      time: string;
      startAt: string;
      endAt: string;
      timezone: string;
    }
  | {
      status: "unavailable";
      date: string;
      time: string;
      timezone: string;
      reason: "outside_business_hours" | "closed" | "conflict" | "in_the_past";
      alternatives: AvailabilitySlot[];
    }
  | {
      status: "unresolved";
      timezone: string;
      reason:
        | "ambiguous_date"
        | "unsupported_date"
        | "missing_time"
        | "invalid_time"
        | "missing_duration"
        | "invalid_duration"
        | "business_hours_unknown";
    };

/**
 * Answers "Esok pukul 10 boleh?" deterministically:
 * relative date -> agency timezone -> business hours -> conflicts.
 * Anything it cannot resolve is reported, never guessed.
 */
export function resolveRequestedSlot(input: {
  phrase: string;
  time?: string | null;
  durationMinutes?: number | null;
  timezone?: string | null;
  businessHours: BusinessHoursConfig;
  events?: CalendarEvent[];
  now?: Date;
}): RequestedSlotResult {
  const now = input.now ?? new Date();
  const tz = normalizeTimezone(input.timezone);
  const relative = resolveRelativeDate(input.phrase, tz, now);
  if (!relative.resolved) {
    return {
      status: "unresolved",
      timezone: tz,
      reason: relative.reason === "ambiguous" ? "ambiguous_date" : "unsupported_date",
    };
  }
  if (input.time === undefined || input.time === null || String(input.time).trim() === "") {
    return { status: "unresolved", timezone: tz, reason: "missing_time" };
  }
  const minutes = parseHhMm(input.time);
  if (minutes === null) return { status: "unresolved", timezone: tz, reason: "invalid_time" };
  if (input.durationMinutes === undefined || input.durationMinutes === null) {
    return { status: "unresolved", timezone: tz, reason: "missing_duration" };
  }
  const duration = normalizeDuration(input.durationMinutes);
  if (duration === null) return { status: "unresolved", timezone: tz, reason: "invalid_duration" };

  const availability = getAvailableSlots({
    date: relative.date,
    timezone: tz,
    businessHours: input.businessHours,
    durationMinutes: duration,
    events: input.events ?? [],
    now,
  });

  if (availability.status === "unresolved") {
    return {
      status: "unresolved",
      timezone: tz,
      reason:
        availability.reason === "invalid_date" ? "unsupported_date" : availability.reason,
    };
  }
  if (availability.status === "closed") {
    return {
      status: "unavailable",
      date: relative.date,
      time: minutesToHhMm(minutes),
      timezone: tz,
      reason: "closed",
      alternatives: [],
    };
  }

  const start = zonedTimeToUtc(relative.date, minutesToHhMm(minutes), tz)!;
  const end = new Date(start.getTime() + duration * 60_000);
  const time = minutesToHhMm(minutes);
  const match = availability.slots.find((s) => s.startAt === start.toISOString());
  if (match) {
    return {
      status: "available",
      date: relative.date,
      time,
      startAt: match.startAt,
      endAt: match.endAt,
      timezone: tz,
    };
  }

  let reason: "outside_business_hours" | "conflict" | "in_the_past" = "outside_business_hours";
  if (start.getTime() < now.getTime()) reason = "in_the_past";
  else if (hasConflict(input.events ?? [], start.toISOString(), end.toISOString())) reason = "conflict";

  return {
    status: "unavailable",
    date: relative.date,
    time,
    timezone: tz,
    reason,
    alternatives: availability.slots.slice(0, 3),
  };
}

/** Business-hours status passthrough so callers keep one time authority. */
export const businessStatusNow = isBusinessOpenNow;
