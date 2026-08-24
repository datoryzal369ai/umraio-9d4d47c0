import { logConversionEvent, type ConversionActor, type ConversionDb } from "./events";

/**
 * UMRAIO® PHASE B-2 — authoritative conversion event producers.
 *
 * Rules enforced here (not at the call sites):
 *  - one event per real state transition, never per render or per message;
 *  - the agency id always comes from the authoritative server/row context;
 *  - metadata stays minimal — no transcripts, no tokens, no extra PII.
 */

/** Lead stages that map onto a funnel conversion event. */
const STAGE_EVENT: Record<string, string> = {
  contacted: "lead_contacted",
  qualified: "lead_qualified",
  lost: "lead_lost",
  booked: "lead_won",
};

export function conversionEventForStage(to: string): string | null {
  return STAGE_EVENT[to] ?? null;
}

export async function recordLeadCreated(args: {
  db: ConversionDb;
  agencyId: string;
  leadId: string | null | undefined;
  actor: ConversionActor;
  source?: string | null;
}) {
  if (!args.leadId) return { ok: false as const, skipped: "no_lead_id" as const };
  const res = await logConversionEvent(args.db, {
    agencyId: args.agencyId,
    stage: "lead_created",
    actor: args.actor,
    leadId: args.leadId,
    meta: args.source ? { source: args.source } : {},
  });
  return { ...res, skipped: null };
}

/**
 * Emits lead_contacted / lead_qualified / lead_lost / lead_won from a REAL
 * stage transition. A no-op when the stage did not actually change, so
 * unrelated lead updates never produce funnel noise.
 */
export async function recordLeadStageTransition(args: {
  db: ConversionDb;
  agencyId: string;
  leadId: string | null | undefined;
  from: string | null | undefined;
  to: string | null | undefined;
  actor: ConversionActor;
  reason?: string | null;
}) {
  if (!args.leadId || !args.to) return { ok: false as const, skipped: "no_transition" as const };
  if (args.from === args.to) return { ok: false as const, skipped: "unchanged" as const };
  const stage = conversionEventForStage(args.to);
  if (!stage) return { ok: false as const, skipped: "stage_not_tracked" as const };
  const res = await logConversionEvent(args.db, {
    agencyId: args.agencyId,
    stage,
    actor: args.actor,
    leadId: args.leadId,
    reason: args.reason ?? null,
    meta: { from: args.from ?? null, to: args.to },
  });
  return { ...res, skipped: null };
}

/** Emitted only when detected package interest actually changes. */
export async function recordPackageInterest(args: {
  db: ConversionDb;
  agencyId: string;
  leadId: string | null | undefined;
  packageName: string | null | undefined;
  previousPackageName?: string | null;
  packageId?: string | null;
  confidence?: number | null;
  actor?: ConversionActor;
}) {
  const name = (args.packageName ?? "").trim();
  if (!args.leadId || !name) return { ok: false as const, skipped: "no_interest" as const };
  if ((args.previousPackageName ?? "").trim() === name) {
    return { ok: false as const, skipped: "unchanged" as const };
  }
  const meta: Record<string, unknown> = { package_name: name };
  if (args.packageId) meta["package_id"] = args.packageId;
  if (typeof args.confidence === "number") meta["confidence"] = args.confidence;
  const res = await logConversionEvent(args.db, {
    agencyId: args.agencyId,
    stage: "package_interest",
    actor: args.actor ?? "ai",
    leadId: args.leadId,
    meta,
  });
  return { ...res, skipped: null };
}

/**
 * booking_confirmed — emitted only from an authoritative booking status
 * transition into "confirmed". Historical/imported rows are never backfilled.
 */
export async function recordBookingStatusTransition(args: {
  db: ConversionDb;
  agencyId: string;
  bookingId: string;
  leadId?: string | null;
  quotationId?: string | null;
  from: string | null | undefined;
  to: string;
  actor: ConversionActor;
  reason?: string | null;
}) {
  if (args.to !== "confirmed") return { ok: false as const, skipped: "not_confirmation" as const };
  if (args.from === "confirmed") return { ok: false as const, skipped: "unchanged" as const };
  const res = await logConversionEvent(args.db, {
    agencyId: args.agencyId,
    stage: "booking_confirmed",
    actor: args.actor,
    leadId: args.leadId ?? null,
    quotationId: args.quotationId ?? null,
    bookingId: args.bookingId,
    reason: args.reason ?? null,
    meta: { from: args.from ?? null, to: args.to },
  });
  return { ...res, skipped: null };
}
