import { beforeEach, describe, expect, mock, test } from "bun:test";

const sent: Array<{ to: string; body: string }> = [];

mock.module("../src/lib/whatsapp-send.server", () => ({
  sendWhatsappText: async (_pid: string, _token: string, to: string, body: string) => {
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

const { dispatchDueFollowups } = await import("../src/lib/followups/dispatcher.server");

const AGENCY = "agency-a";
const OTHER = "agency-b";

type Job = {
  id: string;
  agency_id: string;
  lead_id: string | null;
  conversation_id: string | null;
  quotation_id: string | null;
  title: string;
  body: string | null;
  run_at: string;
  channel: string;
  status: string;
  created_at: string;
  skip_reason?: string | null;
  dispatched_at?: string | null;
};

const past = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

function makeJobs(): Job[] {
  const jobs: Job[] = [];
  // 20 old body-less internal handover tasks ahead of the sendable one.
  for (let i = 0; i < 20; i += 1) {
    jobs.push({
      id: `blank-${i}`,
      agency_id: AGENCY,
      lead_id: "lead-1",
      conversation_id: null,
      quotation_id: null,
      title: "Human attention required",
      body: i % 2 === 0 ? null : "",
      run_at: past(1000 - i),
      channel: "whatsapp",
      status: "pending",
      created_at: past(2000),
    });
  }
  jobs.push({
    id: "sendable-1",
    agency_id: AGENCY,
    lead_id: "lead-1",
    conversation_id: "conv-1",
    quotation_id: null,
    title: "Nudge",
    body: "Assalamualaikum, masih berminat?",
    run_at: past(5),
    channel: "whatsapp",
    status: "pending",
    created_at: past(60),
  });
  jobs.push({
    id: "other-agency",
    agency_id: OTHER,
    lead_id: "lead-2",
    conversation_id: null,
    quotation_id: null,
    title: "Other tenant nudge",
    body: "Should never be sent",
    run_at: past(500),
    channel: "whatsapp",
    status: "pending",
    created_at: past(600),
  });
  return jobs;
}

let jobs: Job[];
const inserted: Record<string, unknown[]> = {};

function tableRows(table: string): Record<string, unknown>[] {
  if (table === "followup_jobs") return jobs as unknown as Record<string, unknown>[];
  if (table === "agencies") return [{ id: AGENCY, timezone: "Asia/Kuala_Lumpur" }];
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
    return [
      {
        id: "lead-1",
        agency_id: AGENCY,
        phone: "60123456789",
        stage: "qualified",
        last_contact_at: past(500),
        full_name: "Ali",
        do_not_contact: false,
      },
      {
        id: "lead-2",
        agency_id: OTHER,
        phone: "60129999999",
        stage: "qualified",
        last_contact_at: null,
        full_name: "Other",
        do_not_contact: false,
      },
    ];
  if (table === "conversations")
    return [
      {
        id: "conv-1",
        agency_id: AGENCY,
        lead_id: "lead-1",
        ai_enabled: true,
        external_id: "60123456789",
        last_message_at: past(30),
      },
    ];
  return [];
}

type Filter = { op: string; col: string; value: unknown };

function makeQuery(table: string) {
  const filters: Filter[] = [];
  let order: { col: string; asc: boolean } | null = null;
  let limitN = Infinity;
  let updatePatch: Record<string, unknown> | null = null;

  const matches = (row: Record<string, unknown>) =>
    filters.every((f) => {
      const v = row[f.col];
      switch (f.op) {
        case "eq":
          return v === f.value;
        case "neq":
          return v !== f.value;
        case "notNull":
          return v !== null && v !== undefined;
        case "lte":
          return String(v) <= String(f.value);
        case "in":
          return (f.value as unknown[]).includes(v);
        default:
          return true;
      }
    });

  const rows = () => {
    let out = tableRows(table).filter(matches);
    if (order) {
      out = [...out].sort((a, b) =>
        String(a[order!.col]) < String(b[order!.col]) ? (order!.asc ? -1 : 1) : (order!.asc ? 1 : -1),
      );
    }
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
    not: (col: string, _op: string, _value: unknown) => {
      filters.push({ op: "notNull", col, value: null });
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
    insert: async (row: unknown) => {
      (inserted[table] ??= []).push(row);
      return { data: null, error: null };
    },
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve),
  };
  return api;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const fakeDb = { from: (table: string) => makeQuery(table) } as any;

describe("follow-up dispatcher head-of-line blocking (P0-1)", () => {
  beforeEach(() => {
    jobs = makeJobs();
    sent.length = 0;
    for (const k of Object.keys(inserted)) delete inserted[k];
  });

  test("dispatches a sendable job that sits behind many old body-less jobs", async () => {
    const result = await dispatchDueFollowups(fakeDb, AGENCY, 5);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Assalamualaikum, masih berminat?");
    expect(result.sent).toBe(1);
  });

  test("body-less jobs are never sent and stay pending for humans", async () => {
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    const blanks = jobs.filter((j) => j.id.startsWith("blank-"));
    expect(blanks.every((j) => j.status === "pending")).toBe(true);
    expect(sent.some((m) => m.body === "" || m.body == null)).toBe(false);
  });

  test("no cross-agency job is ever dispatched", async () => {
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    const other = jobs.find((j) => j.id === "other-agency")!;
    expect(other.status).toBe("pending");
    expect(sent.some((m) => m.body === "Should never be sent")).toBe(false);
  });

  test("dispatched job is marked sent with a dispatch timestamp (retry semantics intact)", async () => {
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    const job = jobs.find((j) => j.id === "sendable-1")!;
    expect(job.status).toBe("sent");
    expect(job.dispatched_at).toBeTruthy();
  });

  test("unsendable-but-bodied jobs are skipped with a reason, not silently dropped", async () => {
    jobs.push({
      id: "dnc-1",
      agency_id: AGENCY,
      lead_id: null,
      conversation_id: null,
      quotation_id: null,
      title: "Orphan",
      body: "hello",
      run_at: past(4),
      channel: "whatsapp",
      status: "pending",
      created_at: past(50),
    });
    await dispatchDueFollowups(fakeDb, AGENCY, 5);
    const job = jobs.find((j) => j.id === "dnc-1")!;
    expect(job.status).toBe("skipped");
    expect(job.skip_reason).toBe("No lead attached");
  });
});
