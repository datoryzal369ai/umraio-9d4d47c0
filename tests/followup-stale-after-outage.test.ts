import { beforeEach, describe, expect, test, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ sent: [] as Array<{ to: string; body: string }> }));
const sent = hoisted.sent;

vi.mock("../src/lib/whatsapp-send.server", () => ({
  sendWhatsappText: async (_pid: string, _token: string, to: string, body: string) => {
    hoisted.sent.push({ to, body });
    return true;
  },
}));
vi.mock("../src/lib/billing/usage.server", () => ({
  QuotaError: class QuotaError extends Error {},
  assertQuota: async () => {},
  recordUsageEvent: async () => {},
}));
vi.mock("../src/lib/quotations/quotations.server", () => ({
  logConversionEvent: async () => {},
}));

const {
  dispatchDueFollowups,
  isStaleFollowup,
  latenessMinutes,
  localHour,
  withinSendWindow,
  STALE_SKIP_REASON,
  DEFAULT_MAX_FOLLOWUP_LATENESS_MINUTES,
} = await import("../src/lib/followups/dispatcher.server");

const AGENCY = "agency-a";

const SEND_WINDOW_TZ = [
  "Asia/Kuala_Lumpur",
  "Europe/London",
  "America/New_York",
  "Pacific/Auckland",
  "America/Los_Angeles",
  "Asia/Dubai",
  "UTC",
].find((tz) => withinSendWindow(localHour(tz)))!;

const past = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

type Job = Record<string, unknown> & { id: string; agency_id: string; status: string };

let jobs: Job[];
let dncLead = false;

function makeJob(id: string, lateMinutes: number): Job {
  return {
    id,
    agency_id: AGENCY,
    lead_id: `lead-${id}`,
    conversation_id: null,
    quotation_id: null,
    title: "Nudge",
    body: `follow-up ${id}`,
    run_at: past(lateMinutes),
    channel: "whatsapp",
    status: "pending",
    created_at: past(lateMinutes + 60),
    attempts: 0,
  };
}

function tableRows(table: string): Record<string, unknown>[] {
  if (table === "followup_jobs") return jobs as Record<string, unknown>[];
  if (table === "agencies") return [{ id: AGENCY, timezone: SEND_WINDOW_TZ }];
  if (table === "whatsapp_configs")
    return [
      {
        agency_id: AGENCY,
        phone_number_id: "pn-1",
        access_token: "tok",
        is_connected: true,
        auto_reply: true,
      },
    ];
  if (table === "leads")
    return jobs.map((j) => ({
      id: j["lead_id"],
      agency_id: AGENCY,
      phone: "60123456789",
      stage: "qualified",
      last_contact_at: null,
      full_name: "Ali",
      do_not_contact: dncLead,
    }));
  return [];
}

type Filter = { op: string; col: string; value: unknown } | { op: "or"; value: Filter[] };

function makeQuery(table: string) {
  const filters: Filter[] = [];
  let order: { col: string; asc: boolean } | null = null;
  let limitN = Infinity;
  let updatePatch: Record<string, unknown> | null = null;

  const evaluate = (row: Record<string, unknown>, f: Filter): boolean => {
    if (f.op === "or") return (f.value as Filter[]).some((sub) => evaluate(row, sub));
    const v = row[(f as { col: string }).col];
    const value = (f as { value: unknown }).value;
    switch (f.op) {
      case "eq":
        return v === value;
      case "neq":
        return v !== value;
      case "notNull":
        return v !== null && v !== undefined;
      case "isNull":
        return v === null || v === undefined;
      case "lte":
        return String(v) <= String(value);
      case "in":
        return (value as unknown[]).includes(v);
      default:
        return true;
    }
  };

  const matches = (row: Record<string, unknown>) => filters.every((f) => evaluate(row, f));

  const rows = () => {
    let out = tableRows(table).filter(matches);
    if (order)
      out = [...out].sort((a, b) =>
        String(a[order!.col]) < String(b[order!.col]) ? (order!.asc ? -1 : 1) : order!.asc ? 1 : -1,
      );
    return out.slice(0, limitN);
  };

  const applyUpdate = () => {
    if (!updatePatch) return;
    for (const row of tableRows(table).filter(matches)) Object.assign(row, updatePatch);
    updatePatch = null;
  };

  const api = {
    select: () => api,
    eq: (col: string, value: unknown) => {
      filters.push({ op: "eq", col, value });
      applyUpdate();
      return api;
    },
    neq: (col: string, value: unknown) => {
      filters.push({ op: "neq", col, value });
      return api;
    },
    not: (col: string) => {
      filters.push({ op: "notNull", col, value: null });
      return api;
    },
    is: (col: string, value: unknown) => {
      filters.push({ op: value === null ? "isNull" : "eq", col, value });
      return api;
    },
    or: (expr: string) => {
      const subs: Filter[] = [];
      for (const part of expr.split(",")) {
        const [col, rawOp, rawVal] = part.split(".");
        if (rawOp === "is" && rawVal === "null") subs.push({ op: "isNull", col: col!, value: null });
        else if (rawOp === "eq") subs.push({ op: "eq", col: col!, value: rawVal ?? "" });
      }
      filters.push({ op: "or", value: subs });
      return api;
    },
    lte: (col: string, value: unknown) => {
      filters.push({ op: "lte", col, value });
      return api;
    },
    in: (col: string, value: unknown[]) => {
      filters.push({ op: "in", col, value });
      applyUpdate();
      return api;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      order = { col, asc: opts?.ascending !== false };
      return api;
    },
    limit: (n: number) => {
      limitN = n;
      return api;
    },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    update: (patch: Record<string, unknown>) => {
      updatePatch = patch;
      return api;
    },
    insert: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve),
  };
  return api;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const fakeDb = {
  from: (table: string) => makeQuery(table),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "claim_followup_job") return { data: null, error: null };
    const job = jobs.find((j) => j.id === args["p_job_id"] && j.agency_id === args["p_agency_id"]);
    if (!job || job.status !== "pending") return { data: false, error: null };
    job.status = "processing";
    job["attempts"] = Number(job["attempts"] ?? 0) + 1;
    return { data: true, error: null };
  },
} as any;

describe("stale follow-up safety after outage", () => {
  beforeEach(() => {
    jobs = [];
    dncLead = false;
    sent.length = 0;
  });

  test("threshold defaults to 60 minutes", () => {
    expect(DEFAULT_MAX_FOLLOWUP_LATENESS_MINUTES).toBe(60);
    expect(latenessMinutes(past(90))).toBeGreaterThanOrEqual(89);
    expect(isStaleFollowup(past(90))).toBe(true);
    expect(isStaleFollowup(past(30))).toBe(false);
  });

  test("A. 5 minutes late is sent", async () => {
    jobs = [makeJob("a", 5)];
    const r = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(r.sent).toBe(1);
    expect(jobs[0]!.status).toBe("sent");
  });

  test("B. 30 minutes late is sent", async () => {
    jobs = [makeJob("b", 30)];
    const r = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(r.sent).toBe(1);
  });

  test("C. 61+ minutes late is skipped as stale", async () => {
    jobs = [makeJob("c", 75)];
    const r = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(r.sent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(jobs[0]!.status).toBe("skipped");
    expect(jobs[0]!["skip_reason"]).toBe(STALE_SKIP_REASON);
  });

  test("D. many hours late after outage is skipped", async () => {
    jobs = [makeJob("d", 11 * 60 + 30)];
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(sent).toHaveLength(0);
    expect(jobs[0]!["skip_reason"]).toBe(STALE_SKIP_REASON);
  });

  test("E. stale backlog is never flushed to WhatsApp", async () => {
    jobs = Array.from({ length: 12 }, (_, i) => makeJob(`bulk-${i}`, 120 + i * 30));
    const r = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(sent).toHaveLength(0);
    expect(r.sent).toBe(0);
    expect(jobs.every((j) => j.status === "skipped" && j["skip_reason"] === STALE_SKIP_REASON)).toBe(
      true,
    );
  });

  test("F. DNC still outranks a fresh follow-up", async () => {
    dncLead = true;
    jobs = [makeJob("f", 5)];
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(sent).toHaveLength(0);
    expect(jobs[0]!["skip_reason"]).toBe("Customer requested no further contact");
  });

  test("G. fresh jobs still send while stale ones in the same batch are skipped", async () => {
    jobs = [makeJob("stale", 600), makeJob("fresh", 10)];
    const r = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(r.sent).toBe(1);
    expect(sent[0]!.body).toBe("follow-up fresh");
    expect(jobs.find((j) => j.id === "stale")!["skip_reason"]).toBe(STALE_SKIP_REASON);
  });
});
