/**
 * UMRAIO® — REAL-TIME CONTEXT v0 (core).
 *
 * Deterministic, dependency-free helpers that turn an authoritative server
 * `Date` plus the agency's stored IANA timezone into a stable calendar view.
 *
 * Time authority rules baked into this module:
 *  - The caller MUST pass the server/runtime clock. There is no browser clock
 *    access here and no client-supplied "now" is ever trusted.
 *  - The timezone MUST come from the authenticated agency record. A missing or
 *    invalid zone falls back to the platform default, never to the client's.
 */

export const DEFAULT_TIMEZONE = "Asia/Kuala_Lumpur";

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type WeekdayName = (typeof WEEKDAYS)[number];

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Business-hours keys as already stored in agency_settings.business_hours. */
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export type DayHours = { open: string; close: string; closed: boolean };
export type BusinessHoursConfig = Partial<Record<DayKey, DayHours | null | undefined>> | null | undefined;

export type AgencyDateTime = {
  /** Authoritative instant, always UTC ISO. */
  isoUtc: string;
  /** Agency-local calendar date, YYYY-MM-DD. */
  date: string;
  /** Agency-local wall-clock time, HH:mm (24h). */
  time: string;
  weekday: WeekdayName;
  weekdayIndex: number;
  month: string;
  monthIndex: number;
  day: number;
  year: number;
  minutesOfDay: number;
  timezone: string;
};

/** Returns the timezone if usable, otherwise the platform default. */
export function normalizeTimezone(timezone?: string | null): string {
  const candidate = (timezone ?? "").trim();
  if (!candidate) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Server clock only. Never accepts a client timestamp. */
export function getCurrentDateTime(now: Date = new Date()): Date {
  return new Date(now.getTime());
}

function parts(now: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) map[p.type] = p.value;
  const hour = Number(map["hour"] === "24" ? "0" : map["hour"]);
  return {
    year: Number(map["year"]),
    month: Number(map["month"]),
    day: Number(map["day"]),
    hour,
    minute: Number(map["minute"]),
    weekdayShort: String(map["weekday"]),
  };
}

const SHORT_WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Full agency-local calendar view of an authoritative instant. */
export function getAgencyLocalDateTime(timezone?: string | null, now: Date = new Date()): AgencyDateTime {
  const tz = normalizeTimezone(timezone);
  const p = parts(now, tz);
  const weekdayIndex = SHORT_WEEKDAY_INDEX[p.weekdayShort] ?? 0;
  return {
    isoUtc: now.toISOString(),
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    weekday: WEEKDAYS[weekdayIndex]!,
    weekdayIndex,
    month: MONTHS[p.month - 1]!,
    monthIndex: p.month,
    day: p.day,
    year: p.year,
    minutesOfDay: p.hour * 60 + p.minute,
    timezone: tz,
  };
}

export function getWeekday(timezone?: string | null, now: Date = new Date()): WeekdayName {
  return getAgencyLocalDateTime(timezone, now).weekday;
}

export function getMonth(timezone?: string | null, now: Date = new Date()): string {
  return getAgencyLocalDateTime(timezone, now).month;
}

/* ------------------------- relative date resolution ------------------------- */

export type RelativeDateResolution =
  | {
      resolved: true;
      date: string;
      weekday: WeekdayName;
      /** Optional day-part hint when the phrase implies one (e.g. "tonight"). */
      partOfDay?: "evening";
      timezone: string;
    }
  | { resolved: false; reason: "ambiguous" | "unsupported"; timezone: string };

const WEEKDAY_ALIASES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  ahad: 0,
  monday: 1,
  mon: 1,
  isnin: 1,
  tuesday: 2,
  tue: 2,
  selasa: 2,
  wednesday: 3,
  wed: 3,
  rabu: 3,
  thursday: 4,
  thu: 4,
  khamis: 4,
  friday: 5,
  fri: 5,
  jumaat: 5,
  jumat: 5,
  saturday: 6,
  sat: 6,
  sabtu: 6,
};

function addDays(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(base);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function weekdayOf(dateIso: string): WeekdayName {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/**
 * Conservative Malay/English relative-date resolution anchored to the
 * agency-local current date. Anything ambiguous returns UNRESOLVED — the
 * resolver never guesses.
 */
export function resolveRelativeDate(
  phrase: string,
  timezone?: string | null,
  now: Date = new Date(),
): RelativeDateResolution {
  const local = getAgencyLocalDateTime(timezone, now);
  const tz = local.timezone;
  const text = (phrase ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { resolved: false, reason: "unsupported", timezone: tz };

  const ok = (date: string, partOfDay?: "evening"): RelativeDateResolution => ({
    resolved: true,
    date,
    weekday: weekdayOf(date),
    ...(partOfDay ? { partOfDay } : {}),
    timezone: tz,
  });

  if (/\b(today|hari ini|harini)\b/.test(text)) return ok(local.date);
  if (/\b(tomorrow|esok|besok)\b/.test(text)) return ok(addDays(local.date, 1));
  if (/\b(yesterday|semalam|kelmarin)\b/.test(text)) return ok(addDays(local.date, -1));
  if (/\b(tonight|malam ini|malam nih)\b/.test(text)) return ok(local.date, "evening");
  if (/\b(next week|minggu depan|minggu hadapan)\b/.test(text)) return ok(addDays(local.date, 7));
  if (/\b(last week|minggu lepas)\b/.test(text)) return ok(addDays(local.date, -7));

  // Weekday phrases must carry an explicit "this" / "next" qualifier.
  const words = text.split(" ");
  for (let i = 0; i < words.length; i += 1) {
    const target = WEEKDAY_ALIASES[words[i]!];
    if (target === undefined) continue;
    const before = words[i - 1];
    const after = words[i + 1];
    const isThis = before === "this" || after === "ini";
    const isNext =
      before === "next" || after === "depan" || after === "hadapan" || before === "coming";
    if (!isThis && !isNext) return { resolved: false, reason: "ambiguous", timezone: tz };
    let delta = (target - local.weekdayIndex + 7) % 7;
    if (isThis && delta === 0) return ok(local.date);
    if (delta === 0) delta = 7;
    return ok(addDays(local.date, isNext ? delta + (delta === 7 ? 0 : 7) : delta));
  }

  return { resolved: false, reason: "unsupported", timezone: tz };
}

/* ------------------------------ business hours ------------------------------ */

export type BusinessStatus = {
  status: "OPEN" | "CLOSED" | "UNKNOWN";
  opensAt?: string;
  closesAt?: string;
  timezone: string;
  localTime: string;
  weekday: WeekdayName;
};

function toMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Deterministic open/closed evaluation against the EXISTING agency
 * business-hours model. Missing or invalid configuration yields UNKNOWN —
 * never a fabricated OPEN.
 */
export function isBusinessOpenNow(
  businessHours: BusinessHoursConfig,
  timezone?: string | null,
  now: Date = new Date(),
): BusinessStatus {
  const local = getAgencyLocalDateTime(timezone, now);
  const base = {
    timezone: local.timezone,
    localTime: local.time,
    weekday: local.weekday,
  };
  if (!businessHours || typeof businessHours !== "object") return { status: "UNKNOWN", ...base };

  const day = businessHours[DAY_KEYS[local.weekdayIndex]!];
  if (!day || typeof day !== "object") return { status: "UNKNOWN", ...base };
  if (day.closed === true) return { status: "CLOSED", ...base };

  const open = toMinutes(day.open);
  const close = toMinutes(day.close);
  if (open === null || close === null) return { status: "UNKNOWN", ...base };

  const minutes = local.minutesOfDay;
  const inRange =
    close > open
      ? minutes >= open && minutes < close
      : // Overnight period (e.g. 20:00 -> 02:00).
        minutes >= open || minutes < close;

  return {
    status: inRange ? "OPEN" : "CLOSED",
    opensAt: day.open,
    closesAt: day.close,
    ...base,
  };
}

/**
 * Compact runtime block injected into the AI system prompt. Values are always
 * produced at request time from the server clock and the agency timezone.
 *
 * Phase 2 adds Hijri + public-holiday awareness through the optional
 * `calendar` hook so this module keeps no dependency on those cores.
 */
export function buildCurrentContextBlock(input: {
  timezone?: string | null;
  businessHours?: BusinessHoursConfig;
  now?: Date;
  /** Optional extra deterministic lines (Hijri / holiday context). */
  extraLines?: (string | null | undefined)[];
}): string {
  const now = input.now ?? new Date();
  const local = getAgencyLocalDateTime(input.timezone, now);
  const business = isBusinessOpenNow(input.businessHours, input.timezone, now);
  return [
    "REAL-TIME CONTEXT (authoritative, generated by the server for this exact request):",
    `CURRENT DATE: ${local.date}`,
    `CURRENT TIME: ${local.time}`,
    `TIMEZONE: ${local.timezone}`,
    `DAY: ${local.weekday}`,
    `MONTH: ${local.month} ${local.year}`,
    `BUSINESS STATUS: ${business.status}`,
    ...(input.extraLines ?? []).filter((l): l is string => Boolean(l)),
    "Always answer questions about the current date, time, day, month or year from this block. Never use remembered or assumed dates, and resolve relative phrases (today, esok, Jumaat depan, next week) against CURRENT DATE.",
  ].join("\n");
}

