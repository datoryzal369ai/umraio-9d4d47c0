import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { logConversionEvent } from "@/lib/quotations/quotations.server";

type Insert = Record<string, unknown>;

function makeClient(result: { error: { code?: string; message: string } | null }) {
  const inserts: Insert[] = [];
  const client = {
    from(table: string) {
      expect(table).toBe("conversion_events");
      return {
        insert(row: Insert) {
          inserts.push(row);
          return Promise.resolve(result);
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, inserts };
}

const AGENCY_A = "11111111-1111-1111-1111-111111111111";

describe("B-1 conversion telemetry write path", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("writes an event scoped to the caller's agency", async () => {
    const { client, inserts } = makeClient({ error: null });
    const outcome = await logConversionEvent(client, {
      agencyId: AGENCY_A,
      stage: "quotation_created",
      leadId: null,
    });
    expect(outcome).toEqual({ ok: true, error: null });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!["agency_id"]).toBe(AGENCY_A);
    expect(inserts[0]!["stage"]).toBe("quotation_created");
    expect(inserts[0]!["actor"]).toBe("ai");
    expect(inserts[0]!["meta"]).toEqual({});
  });

  it("surfaces an RLS rejection instead of swallowing it", async () => {
    const { client } = makeClient({
      error: { code: "42501", message: "new row violates row-level security policy" },
    });
    const outcome = await logConversionEvent(client, {
      agencyId: "22222222-2222-2222-2222-222222222222",
      stage: "quotation_created",
    });
    expect(outcome.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]![0]);
    expect(line).toContain("[conversion-telemetry] insert_failed");
    expect(line).toContain("code=42501");
  });

  it("does not break the business transaction when telemetry fails", async () => {
    const { client } = makeClient({ error: { code: "42501", message: "denied" } });
    await expect(
      logConversionEvent(client, { agencyId: AGENCY_A, stage: "quotation_sent" }),
    ).resolves.toBeDefined();
  });

  it("never logs customer identifiers or free-text reason", async () => {
    const { client } = makeClient({ error: { code: "42501", message: "denied" } });
    await logConversionEvent(client, {
      agencyId: AGENCY_A,
      stage: "quotation_sent",
      reason: "customer +60123456789 asked for discount",
      meta: { phone: "+60123456789" },
    });
    const line = String(errorSpy.mock.calls[0]![0]);
    expect(line).not.toContain("60123456789");
  });
});
