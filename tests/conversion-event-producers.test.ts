import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  recordBookingStatusTransition,
  recordLeadCreated,
  recordLeadStageTransition,
  recordPackageInterest,
} from "@/lib/conversion/producers";

type Row = Record<string, unknown>;

function makeClient(error: { code?: string; message: string } | null = null) {
  const inserts: Row[] = [];
  const client = {
    from(table: string) {
      expect(table).toBe("conversion_events");
      return {
        insert(row: Row) {
          inserts.push(row);
          return Promise.resolve({ error });
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: client as any, inserts };
}

const AGENCY_A = "11111111-1111-1111-1111-111111111111";
const AGENCY_B = "22222222-2222-2222-2222-222222222222";
const LEAD = "33333333-3333-3333-3333-333333333333";

describe("B-2 conversion event producers", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("lead_created carries lead, agency, actor and source", async () => {
    const { db, inserts } = makeClient();
    await recordLeadCreated({
      db,
      agencyId: AGENCY_A,
      leadId: LEAD,
      actor: "customer",
      source: "whatsapp",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      stage: "lead_created",
      agency_id: AGENCY_A,
      lead_id: LEAD,
      actor: "customer",
      meta: { source: "whatsapp" },
    });
  });

  it("lead_contacted, lead_qualified, lead_lost and lead_won map from real transitions", async () => {
    const cases: Array<[string, string, string]> = [
      ["new", "contacted", "lead_contacted"],
      ["contacted", "qualified", "lead_qualified"],
      ["qualified", "lost", "lead_lost"],
      ["proposal", "booked", "lead_won"],
    ];
    for (const [from, to, stage] of cases) {
      const { db, inserts } = makeClient();
      await recordLeadStageTransition({
        db,
        agencyId: AGENCY_A,
        leadId: LEAD,
        from,
        to,
        actor: "ai",
        reason: null,
      });
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toMatchObject({
        stage,
        agency_id: AGENCY_A,
        lead_id: LEAD,
        actor: "ai",
        meta: { from, to },
      });
    }
  });

  it("repeated unrelated lead updates emit nothing", async () => {
    const { db, inserts } = makeClient();
    // same stage twice (score/temperature style update)
    await recordLeadStageTransition({
      db,
      agencyId: AGENCY_A,
      leadId: LEAD,
      from: "qualified",
      to: "qualified",
      actor: "ai",
    });
    // untracked stage
    await recordLeadStageTransition({
      db,
      agencyId: AGENCY_A,
      leadId: LEAD,
      from: "qualified",
      to: "proposal",
      actor: "ai",
    });
    // no lead id
    await recordLeadStageTransition({
      db,
      agencyId: AGENCY_A,
      leadId: null,
      from: "new",
      to: "contacted",
      actor: "ai",
    });
    expect(inserts).toHaveLength(0);
  });

  it("package_interest emits once per change with minimal metadata", async () => {
    const { db, inserts } = makeClient();
    await recordPackageInterest({
      db,
      agencyId: AGENCY_A,
      leadId: LEAD,
      packageName: "Menara Jam 14N",
      previousPackageName: null,
      packageId: "pkg-1",
      confidence: 0.8,
    });
    await recordPackageInterest({
      db,
      agencyId: AGENCY_A,
      leadId: LEAD,
      packageName: "Menara Jam 14N",
      previousPackageName: "Menara Jam 14N",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      stage: "package_interest",
      lead_id: LEAD,
      actor: "ai",
      meta: { package_name: "Menara Jam 14N", package_id: "pkg-1", confidence: 0.8 },
    });
    expect(JSON.stringify(inserts[0])).not.toContain("transcript");
  });

  it("booking_confirmed only fires on an authoritative confirmation transition", async () => {
    const { db, inserts } = makeClient();
    await recordBookingStatusTransition({
      db,
      agencyId: AGENCY_A,
      bookingId: "bk-1",
      leadId: LEAD,
      quotationId: "q-1",
      from: "deposit_paid",
      to: "confirmed",
      actor: "human",
    });
    await recordBookingStatusTransition({
      db,
      agencyId: AGENCY_A,
      bookingId: "bk-1",
      from: "confirmed",
      to: "confirmed",
      actor: "human",
    });
    await recordBookingStatusTransition({
      db,
      agencyId: AGENCY_A,
      bookingId: "bk-1",
      from: "pending",
      to: "deposit_paid",
      actor: "human",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      stage: "booking_confirmed",
      booking_id: "bk-1",
      quotation_id: "q-1",
      lead_id: LEAD,
      actor: "human",
    });
  });

  it("never writes an event for another tenant", async () => {
    const { db, inserts } = makeClient();
    await recordLeadStageTransition({
      db,
      agencyId: AGENCY_B,
      leadId: LEAD,
      from: "new",
      to: "contacted",
      actor: "human",
    });
    expect(inserts[0]?.["agency_id"]).toBe(AGENCY_B);
    expect(inserts.every((row) => row["agency_id"] !== AGENCY_A)).toBe(true);
  });

  it("surfaces a write failure without throwing", async () => {
    const { db } = makeClient({ code: "42501", message: "permission denied" });
    const res = await recordLeadCreated({
      db,
      agencyId: AGENCY_A,
      leadId: LEAD,
      actor: "system",
    });
    expect(res.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
