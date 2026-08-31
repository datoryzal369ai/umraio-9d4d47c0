import { beforeEach, describe, expect, mock, test } from "vitest";

/**
 * PHASE B-3.1 — follow-up retry + atomic claim.
 *
 * Verifies that transport failures retry with backoff, business refusals never
 * retry, MAX_ATTEMPTS is terminal, two concurrent dispatchers cannot claim the
 * same job, and tenant isolation holds.
 */

let sendOk = true;
const sent: Array<{ to: string; body: string }> = [];

mock.module("../src/lib/whatsapp-send.server", () => ({
  sendWhatsappText: async (_pid: string, _token: string, to: string, body: string) => {
    if (!sendOk) return false;
    sent.push({ to, body });
    return true;
  },
}));
mock.module("../src/lib/billing/usage.server", () => ({
  QuotaError: class QuotaError extends Error {},
  assertQuota: async () => {},
  recordUsageEvent: async () => {},
}));
mock.module("../src/lib/quotations/quotations.server", () => ({
  logConversionEvent: async () => {},
}));

const { dispatchDueFollowups, nextRetryAt, MAX_ATTEMPTS, localHour, withinSendWindow } =
  await import("../src/lib/followups/dispatcher.server");

const AGENCY = "agency-a";
const OTHER = "agency-b";

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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

let jobs: Row[];
let leads: Row[];
let conversations: Row[];
let claimCalls = 0;

function baseJob(over: Row = {}): Row {
  return {
    id: "job-1",
    agency_id: AGENCY,
    lead_id: "lead-1",
    conversation_id: "conv-1",
    quotation_id: null,
    title: "Nudge",
    body: "Assalamualaikum, masih berminat?",
    run_at: past(5),
    channel: "whatsapp",
    status: "pending",
    attempts: 0,
    claimed_at: null,
    created_at: past(60),
    ...over,
  };
}

function tableRows(table: string): Row[] {
  if (table === "followup_jobs") return jobs;
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
  if (table === "leads") return leads;
  if (table === "conversations") return conversations;
  return [];
}

type Filter =
  | { op: string; col: string; value: unknown }
  | { op: "or"; value: Filter[] };

function makeQuery(table: string) {
  const filters: Filter[] = [];
  let order: { col: string; asc: boolean } | null = null;
  let limitN = Infinity;
  let updatePatch: Row | null = null;

  const evaluate = (row: Row, f: Filter): boolean => {
    if (f.op === "or") {
      return (f.value as Filter[]).some((sub) => evaluate(row, sub));
    }
    const v = row[f.col];
    switch (f.op) {
      case "eq":
        return v === f.value;
      case "neq":
        return v !== f.value;
      case "notNull":
        return v !== null && v !== undefined;
      case "isNull":
        return v === null || v === undefined;
      case "lte":
        return String(v) <= String(f.value);
      case "in":
        return (f.value as unknown[]).includes(v);
      default:
        return true;
    }
  };

  const matches = (row: Row) => filters.every((f) => evaluate(row, f));

  const rows = () => {
    let out = tableRows(table).filter(matches);
    if (order) {
      out = [...out].sort((a, b) =>
        String(a[order!.col]) < String(b[order!.col]) ? (order!.asc ? -1 : 1) : order!.asc ? 1 : -1,
      );
    }
    return out.slice(0, limitN);
  };

  const applyUpdate = () => {
    if (!updatePatch) return;
    for (const row of tableRows(table).filter(matches)) Object.assign(row, updatePatch);
    updatePatch = null;
  };

  const api: any = {
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
        if (rawOp === "is" && rawVal === "null") subs.push({ op: "isNull", col, value: null });
        else if (rawOp === "eq") subs.push({ op: "eq", col, value: rawVal === "" ? "" : rawVal });
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
    update: (patch: Row) => {
      updatePatch = patch;
      return api;
    },
    insert: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve),
  };
  return api;
}

/** Mirrors the SQL claim: only pending (or stale processing) rows in the caller's
 *  own tenant can be claimed, and the claim increments attempts atomically. */
function claim(args: Row) {
  claimCalls += 1;
  const job = jobs.find((j) => j.id === args["p_job_id"] && j.agency_id === args["p_agency_id"]);
  if (!job || job.status !== "pending") return { data: false, error: null };
  job.status = "processing";
  job.claimed_at = new Date().toISOString();
  job.attempts = (job.attempts ?? 0) + 1;
  return { data: true, error: null };
}

const fakeDb = {
  from: (table: string) => makeQuery(table),
  rpc: async (fn: string, args: Row) =>
    fn === "claim_followup_job" ? claim(args) : { data: null, error: null },
} as any;

describe("B-3.1 follow-up retry + atomic claim", () => {
  beforeEach(() => {
    sendOk = true;
    sent.length = 0;
    claimCalls = 0;
    jobs = [baseJob()];
    leads = [
      {
        id: "lead-1",
        agency_id: AGENCY,
        phone: "60123456789",
        stage: "qualified",
        last_contact_at: past(500),
        full_name: "Ali",
        do_not_contact: false,
      },
    ];
    conversations = [
      {
        id: "conv-1",
        agency_id: AGENCY,
        lead_id: "lead-1",
        ai_enabled: true,
        external_id: "60123456789",
        last_message_at: past(30),
      },
    ];
  });

  test("backoff policy is bounded by MAX_ATTEMPTS", () => {
    expect(nextRetryAt(1)).toBeInstanceOf(Date);
    expect(nextRetryAt(2)!.getTime()).toBeGreaterThan(nextRetryAt(1)!.getTime());
    expect(nextRetryAt(MAX_ATTEMPTS)).toBeNull();
  });

  test("transient send failure schedules a retry and increments attempts", async () => {
    sendOk = false;
    const result = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    const job = jobs[0]!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now());
    expect(job.last_error).toBe("WhatsApp send failed");
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
  });

  test("maximum attempts is terminal — no further retry", async () => {
    sendOk = false;
    jobs = [baseJob({ attempts: MAX_ATTEMPTS - 1 })];
    const result = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    const job = jobs[0]!;
    expect(job.attempts).toBe(MAX_ATTEMPTS);
    expect(job.status).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
  });

  test("do-not-contact never reaches the claim and never retries", async () => {
    leads[0]!.do_not_contact = true;
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(claimCalls).toBe(0);
    expect(jobs[0]!.status).toBe("skipped");
    expect(jobs[0]!.attempts).toBe(0);
  });

  test("human takeover never reaches the claim and never retries", async () => {
    conversations[0]!.ai_enabled = false;
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(claimCalls).toBe(0);
    expect(jobs[0]!.status).toBe("skipped");
    expect(jobs[0]!.skip_reason).toBe("Conversation is under human takeover");
  });

  test("permanent configuration failure is skipped, not retried", async () => {
    leads[0]!.phone = null;
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(jobs[0]!.status).toBe("skipped");
    expect(jobs[0]!.attempts).toBe(0);
  });

  test("two concurrent dispatchers cannot claim the same job", async () => {
    const [a, b] = await Promise.all([
      dispatchDueFollowups(fakeDb, AGENCY, 5),
      dispatchDueFollowups(fakeDb, AGENCY, 5),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(jobs[0]!.attempts).toBe(1);
  });

  test("a successful job produces exactly one send and one sent row", async () => {
    const result = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(jobs[0]!.status).toBe("sent");
    expect(jobs[0]!.dispatched_at).toBeTruthy();
  });

  test("tenant isolation — another agency's job is never claimed or sent", async () => {
    jobs = [baseJob({ id: "job-other", agency_id: OTHER, body: "Should never be sent" })];
    const result = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(result.sent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(jobs[0]!.status).toBe("pending");
    expect(jobs[0]!.attempts).toBe(0);
  });
});
