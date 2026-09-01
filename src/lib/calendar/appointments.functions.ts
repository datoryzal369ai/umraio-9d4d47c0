/**
 * UMRAIO® — PHASE 3: INTERNAL CALENDAR + APPOINTMENT FOUNDATION (server).
 *
 * READ-ONLY foundation. Every function runs through `requireSupabaseAuth`, so
 * reads happen with the caller's own RLS-scoped client and the
 * `agency_id = private.current_agency_id()` policy is the tenant boundary.
 * The agency is resolved server-side from the caller's profile — an
 * `agency_id` supplied by the client is never accepted, and no service-role
 * client is used here.
 *
 * FUTURE INTEGRATION: Google / Microsoft calendars would be merged into the
 * same `CalendarEvent[]` shape before availability is computed. No external
 * provider, OAuth, sync or webhook exists in this phase.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { BusinessHoursConfig } from "@/lib/context/realtime-context.core";
import {
  getAvailableSlots as computeAvailableSlots,
  isValidDateIso,
  resolveRequestedSlot as computeRequestedSlot,
  type AppointmentStatus,
  type CalendarEvent,
} from "./appointments.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from: (table: string) => any };

type AgencyRuntime = { agencyId: string; timezone: string | null; businessHours: BusinessHoursConfig };

/** Server-authoritative tenant + time settings. Never client input. */
async function loadAgencyRuntime(supabase: Db, userId: string): Promise<AgencyRuntime | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  const agencyId = (profile?.agency_id ?? null) as string | null;
  if (!agencyId) return null;

  const [{ data: agency }, { data: settings }] = await Promise.all([
    supabase.from("agencies").select("timezone").eq("id", agencyId).maybeSingle(),
    supabase
      .from("agency_settings")
      .select("business_hours")
      .eq("agency_id", agencyId)
      .maybeSingle(),
  ]);

  return {
    agencyId,
    timezone: (agency?.timezone ?? null) as string | null,
    businessHours: (settings?.business_hours ?? null) as BusinessHoursConfig,
  };
}

function toCalendarEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: String(row["id"]),
    title: String(row["title"] ?? ""),
    startAt: new Date(String(row["start_at"])).toISOString(),
    endAt: new Date(String(row["end_at"])).toISOString(),
    status: String(row["status"]) as AppointmentStatus,
    leadId: (row["lead_id"] as string | null) ?? null,
  };
}

async function fetchEvents(
  supabase: Db,
  agencyId: string,
  fromIso: string,
  toIso: string,
): Promise<CalendarEvent[]> {
  const { data } = await supabase
    .from("appointments")
    // Defence in depth: RLS already scopes this, the filter makes it explicit.
    .select("id, title, start_at, end_at, status, lead_id")
    .eq("agency_id", agencyId)
    .lt("start_at", toIso)
    .gt("end_at", fromIso)
    .order("start_at", { ascending: true })
    .limit(500);
  return ((data ?? []) as Record<string, unknown>[]).map(toCalendarEvent);
}

function windowFor(input: { from?: string | null; to?: string | null }) {
  const from = input.from && !Number.isNaN(Date.parse(input.from)) ? new Date(input.from) : new Date();
  const to =
    input.to && !Number.isNaN(Date.parse(input.to))
      ? new Date(input.to)
      : new Date(from.getTime() + 30 * 86_400_000);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/** Read-only calendar events for the caller's agency, within a window. */
export const getCalendarEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { from?: string | null; to?: string | null } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Db; userId: string };
    const runtime = await loadAgencyRuntime(supabase, userId);
    if (!runtime) return { events: [] as CalendarEvent[], timezone: null as string | null };
    const { fromIso, toIso } = windowFor(data);
    return {
      events: await fetchEvents(supabase, runtime.agencyId, fromIso, toIso),
      timezone: runtime.timezone,
    };
  });

/** Read-only availability for one agency-local date. */
export const getAvailableSlots = createServerFn({ method: "POST" })
  .inputValidator((input: { date: string; durationMinutes?: number | null }) => ({
    date: String(input?.date ?? ""),
    durationMinutes: input?.durationMinutes ?? null,
  }))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Db; userId: string };
    const runtime = await loadAgencyRuntime(supabase, userId);
    if (!runtime) {
      return { status: "unresolved" as const, reason: "business_hours_unknown" as const, timezone: null };
    }
    if (!isValidDateIso(data.date)) {
      return { status: "unresolved" as const, reason: "invalid_date" as const, timezone: runtime.timezone };
    }
    const dayStart = new Date(`${data.date}T00:00:00.000Z`);
    const events = await fetchEvents(
      supabase,
      runtime.agencyId,
      new Date(dayStart.getTime() - 86_400_000).toISOString(),
      new Date(dayStart.getTime() + 2 * 86_400_000).toISOString(),
    );
    return computeAvailableSlots({
      date: data.date,
      timezone: runtime.timezone,
      businessHours: runtime.businessHours,
      durationMinutes: data.durationMinutes,
      events,
      now: new Date(),
    });
  });

/** Read-only "is <relative phrase> at <time> free?" resolution. */
export const checkRequestedSlot = createServerFn({ method: "POST" })
  .inputValidator((input: { phrase: string; time?: string | null; durationMinutes?: number | null }) => ({
    phrase: String(input?.phrase ?? ""),
    time: input?.time ?? null,
    durationMinutes: input?.durationMinutes ?? null,
  }))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Db; userId: string };
    const runtime = await loadAgencyRuntime(supabase, userId);
    if (!runtime) {
      return { status: "unresolved" as const, reason: "business_hours_unknown" as const, timezone: null };
    }
    const now = new Date();
    const events = await fetchEvents(
      supabase,
      runtime.agencyId,
      new Date(now.getTime() - 86_400_000).toISOString(),
      new Date(now.getTime() + 60 * 86_400_000).toISOString(),
    );
    return computeRequestedSlot({
      phrase: data.phrase,
      time: data.time,
      durationMinutes: data.durationMinutes,
      timezone: runtime.timezone,
      businessHours: runtime.businessHours,
      events,
      now,
    });
  });
