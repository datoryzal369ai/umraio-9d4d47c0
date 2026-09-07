import { describe, expect, it, vi } from "vitest";
import { processCallEvent, processGatewayCallback } from "@/lib/calls/calls.server";

const CALL = "wacid.lifecycle-test";
const AGENCY = "agency-test";
const PHONE = "phone-test";
const ACCEPTED_AT = "2026-09-06T07:45:06.199Z";
const READY_AT = "2026-09-06T07:45:08.000Z";

// Apply writes only when the query is awaited, including its WHERE predicates.
// Returned PostgREST errors never mutate the row, unlike the old eager mocks.
type TestRow = Record<string, unknown> & { stage_timings: Record<string, unknown> };

function database(
  initial: TestRow | null,
  options: {
    failWrite?: (patch: Record<string, unknown>) => boolean;
    failRead?: () => boolean;
    beforeWrite?: (row: TestRow, patch: Record<string, unknown>) => void;
    configAgency?: string;
  } = {},
) {
  const state = { row: initial };
  const db = {
    from(table: string) {
      let patch: Record<string, unknown> | undefined;
      const filters: Array<[string, unknown]> = [];
      const execute = async () => {
        if (table === "whatsapp_configs")
          return {
            data: { agency_id: options.configAgency ?? AGENCY, access_token: "test-meta-token" },
            error: null,
          };
        if (!patch && options.failRead?.()) return { data: null, error: { code: "08006" } };
        if (patch && state.row) {
          options.beforeWrite?.(state.row, patch);
          if (options.failWrite?.(patch)) return { data: null, error: { code: "23514" } };
          if (!filters.every(([key, value]) => state.row![key] === value))
            return { data: null, error: null };
          state.row = { ...state.row, ...patch };
        }
        return { data: state.row ? { ...state.row } : null, error: null };
      };
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return query;
        },
        is: (key: string, value: unknown) => {
          filters.push([key, value]);
          return query;
        },
        update: (value: Record<string, unknown>) => {
          patch = value;
          return query;
        },
        insert: async (value: Record<string, unknown>) => {
          state.row = { id: "row-test", stage_timings: {}, ...value };
          return { error: null };
        },
        maybeSingle: execute,
        then: (
          resolve: (value: Awaited<ReturnType<typeof execute>>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => execute().then(resolve, reject),
      };
      return query;
    },
  };
  return { db, state };
}

const acceptedSession = () => ({
  id: "row-test",
  call_id: CALL,
  agency_id: AGENCY,
  phone_number_id: PHONE,
  status: "meta_pre_accepted",
  gateway_session_id: "ms_test",
  meta_accepted_at: ACCEPTED_AT,
  callback_nonces: [],
  stage_timings: {},
});
const ready = () => ({
  call_id: CALL,
  session_id: "ms_test",
  event: "media_ready" as const,
  timestamp: READY_AT,
  nonce: "nonce-test",
  inbound_packets: 1,
  outbound_packets: 1,
});
const farewell = () => ({
  ...ready(),
  event: "media_terminated" as const,
  reason: "conversation_complete",
});

describe("Calling lifecycle persistence", () => {
  it("surfaces a callback read failure so the unchanged nonce can retry", async () => {
    let failing = true;
    const { db, state } = database(acceptedSession(), { failRead: () => failing });
    await expect(processGatewayCallback({ db, payload: ready() })).rejects.toThrow(
      "call_persistence_callback_read",
    );
    expect(state.row?.callback_nonces).toEqual([]);
    failing = false;
    await expect(processGatewayCallback({ db, payload: ready() })).resolves.toEqual({
      applied: true,
      outcome: "answered",
    });
  });

  it("does not acknowledge a callback whose database write failed; the same nonce can retry", async () => {
    let failing = true;
    const { db, state } = database(acceptedSession(), { failWrite: () => failing });
    await expect(processGatewayCallback({ db, payload: ready() })).rejects.toThrow();
    expect(state.row?.callback_nonces).toEqual([]);
    failing = false;
    await expect(processGatewayCallback({ db, payload: ready() })).resolves.toEqual({
      applied: true,
      outcome: "answered",
    });
  });

  it("cannot revive a call terminated between callback read and write", async () => {
    const { db, state } = database(acceptedSession(), {
      beforeWrite(row, patch) {
        if (patch.status === "answered") row.status = "terminated";
      },
    });
    const result = await processGatewayCallback({ db, payload: ready() });
    expect(result.applied).toBe(false);
    expect(state.row?.status).toBe("terminated");
  });

  it("retries a failure callback when a concurrent readiness transition wins", async () => {
    let racing = true;
    const { db, state } = database(acceptedSession(), {
      beforeWrite(row, patch) {
        if (racing && patch.status === "failed") {
          racing = false;
          row.status = "answered";
        }
      },
    });
    const payload = { ...ready(), event: "media_failed" as const, reason: "ice_failed" };
    await expect(processGatewayCallback({ db, payload })).rejects.toThrow(
      "call_persistence_concurrent_state_change",
    );
    expect(state.row?.callback_nonces).toEqual([]);
    await expect(processGatewayCallback({ db, payload })).resolves.toEqual({
      applied: true,
      outcome: "failed",
    });
    expect(state.row?.termination_reason).toBe("ice_failed");
  });

  it("sends graceful Meta termination once using the stored tenant, with no SDP", async () => {
    const { db, state } = database(acceptedSession());
    const fetchImpl = vi.fn(async () =>
      Response.json({ success: true }),
    ) as unknown as typeof fetch;
    await processGatewayCallback({ db, payload: farewell(), fetchImpl });
    await processGatewayCallback({ db, payload: farewell(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toContain(`/${PHONE}/calls`);
    expect(JSON.parse(String(request?.body))).toEqual({
      messaging_product: "whatsapp",
      call_id: CALL,
      action: "terminate",
    });
    expect(state.row?.stage_timings.meta_terminate_outcome).toBe("ok");
  });

  it.each(["caller_terminated", "ice_failed"])(
    "does not send Meta terminate for %s",
    async (reason) => {
      const { db } = database(acceptedSession());
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      await processGatewayCallback({ db, payload: { ...farewell(), reason }, fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("claims Meta teardown once when two farewell callbacks arrive concurrently", async () => {
    const { db } = database(acceptedSession());
    const fetchImpl = vi.fn(async () =>
      Response.json({ success: true }),
    ) as unknown as typeof fetch;
    const results = await Promise.all([
      processGatewayCallback({ db, payload: farewell(), fetchImpl }),
      processGatewayCallback({ db, payload: { ...farewell(), nonce: "second-nonce" }, fetchImpl }),
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not send Meta teardown if the terminal transition was not committed", async () => {
    const { db } = database(acceptedSession(), { failWrite: () => true });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(processGatewayCallback({ db, payload: farewell(), fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not use another tenant's Meta token", async () => {
    const { db, state } = database(acceptedSession(), { configAgency: "other-agency" });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await processGatewayCallback({ db, payload: farewell(), fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.row?.stage_timings.meta_terminate_outcome).toBe("skipped:tenant_unresolved");
  });

  it("keeps the terminal state when Meta termination fails and records that outcome", async () => {
    const { db, state } = database(acceptedSession());
    await processGatewayCallback({
      db,
      payload: farewell(),
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    expect(state.row?.status).toBe("terminated");
    expect(state.row?.stage_timings.meta_terminate_outcome).toBe("failed:meta_terminate_http_503");
  });

  it("preserves timing marks committed while Meta termination is in flight", async () => {
    const { db, state } = database(acceptedSession());
    await processGatewayCallback({
      db,
      payload: farewell(),
      fetchImpl: async () => {
        state.row!.stage_timings = {
          ...state.row!.stage_timings,
          call_memory_outcome: "insert_failed",
        };
        return Response.json({ success: true });
      },
    });
    expect(state.row?.stage_timings.call_memory_outcome).toBe("insert_failed");
    expect(state.row?.stage_timings.meta_terminate_outcome).toBe("ok");
  });
});

const env = {
  WHATSAPP_MEDIA_GATEWAY_URL: "https://gateway.test",
  WHATSAPP_MEDIA_GATEWAY_SECRET: "test-gateway-secret-only",
};
const connect = {
  callId: CALL,
  callerPhone: "60123456789",
  status: "ringing" as const,
  direction: "inbound" as const,
  sdp: { type: "offer", sdp: "test-offer" },
  terminationReason: null,
  occurredAt: ACCEPTED_AT,
};

describe("post-accept persistence boundary", () => {
  it.each(["started", "closed", "disabled", "outage"])(
    "records the actual %s notification result without erasing concurrent readiness",
    async (greeting) => {
      const { db, state } = database(null);
      const fetchImpl: typeof fetch = async (url) => {
        if (String(url).endsWith("/offer"))
          return Response.json({
            session_id: "ms_test",
            sdp_answer: "test-answer",
            state: "media_negotiating",
          });
        if (String(url).endsWith("/accepted")) {
          await processGatewayCallback({ db, payload: ready(), now: () => new Date(READY_AT) });
          return greeting === "outage"
            ? new Response(null, { status: 503 })
            : Response.json({ greeting });
        }
        if (String(url).endsWith("/health")) return Response.json({ speech: "up" });
        return Response.json({ success: true });
      };
      await processCallEvent({ db, event: connect, phoneNumberId: PHONE, env, fetchImpl });
      const timings = state.row!.stage_timings;
      expect(timings.media_ready_at).toBe(READY_AT);
      if (greeting === "started") {
        expect(timings.post_accept_notified_at).toEqual(expect.any(String));
        expect(timings.post_accept_notify_outcome).toBe("confirmed:started");
      } else {
        expect(timings.post_accept_notified_at).toBeUndefined();
        expect(timings.post_accept_notify_outcome).toMatch(/^(unconfirmed|failed):/);
      }
    },
  );

  it("does not orphan an accepted call when storing the acceptance anchor failed", async () => {
    let attempts = 0;
    const { db } = database(null, {
      failWrite: (patch) => {
        if (!patch.meta_accepted_at) return false;
        attempts += 1;
        return true;
      },
    });
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      seen.push(String(url));
      return String(url).endsWith("/offer")
        ? Response.json({
            session_id: "ms_test",
            sdp_answer: "test-answer",
            state: "media_negotiating",
          })
        : Response.json({ success: true });
    };
    await expect(
      processCallEvent({ db, event: connect, phoneNumberId: PHONE, env, fetchImpl }),
    ).resolves.toBe("meta_accepted");
    expect(attempts).toBe(2);
    expect(seen.filter((url) => url.endsWith("/accepted"))).toHaveLength(1);
  });

  it("continues after the existing acceptance retry commits successfully", async () => {
    let attempts = 0;
    const { db, state } = database(null, {
      failWrite: (patch) => {
        if (!patch.meta_accepted_at) return false;
        attempts += 1;
        return attempts === 1;
      },
    });
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      seen.push(String(url));
      if (String(url).endsWith("/offer"))
        return Response.json({
          session_id: "ms_test",
          sdp_answer: "test-answer",
          state: "media_negotiating",
        });
      if (String(url).endsWith("/accepted")) {
        expect(state.row?.meta_accepted_at).toEqual(expect.any(String));
        return Response.json({ greeting: "started" });
      }
      return Response.json({ success: true, speech: "up" });
    };
    await expect(
      processCallEvent({ db, event: connect, phoneNumberId: PHONE, env, fetchImpl }),
    ).resolves.toBe("meta_accepted");
    expect(attempts).toBe(2);
    expect(seen.filter((url) => url.endsWith("/accepted"))).toHaveLength(1);
  });
});
