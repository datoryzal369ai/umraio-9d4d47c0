import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/whatsapp-send.server", () => ({ sendWhatsappTextDetailed: mocks.send }));
import { deliverCallingQuotation } from "../src/lib/calls/call-quotation.server";
import { callingDb } from "./helpers/calling-worker-db";
const request = { agencyId: "agency", callId: "synthetic-call", sequence: 8, transcript: "Hantar quotation sekarang dekat WhatsApp, boleh?", leadId: "lead", conversationId: "conversation", quotationId: "quotation" };
beforeEach(() => { mocks.send.mockReset(); });

it.each(["timeout", "cancelled", "unverified_receipt"])("keeps %s delivery unknown, durably claimed and never retried", async cause => {
  const fixture = callingDb(); const owner = new AbortController();
  mocks.send.mockResolvedValue({ ok: false, providerMessageId: null, outcome: "outcome_unknown", cause, dispatched: true });
  const result = await deliverCallingQuotation({ ...request, db: fixture.db, execution: { signal: owner.signal } });
  expect(result).toMatchObject({ ok: false, outcome: "outcome_unknown" });
  expect(mocks.send.mock.calls[0]![4].signal).toBe(owner.signal);
  expect(fixture.tables.ai_tasks![0]).toMatchObject({ status: "running", output: { delivery_outcome: "outcome_unknown", cause } });
  expect(fixture.tables.messages).toEqual([]);
  await deliverCallingQuotation({ ...request, db: fixture.db, execution: { signal: owner.signal } });
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it("preserves verified receipts when assistant speech is cancelled after dispatch", async () => {
  const fixture = callingDb(); const speech = new AbortController(); const execution = new AbortController();
  mocks.send.mockImplementation(async () => { speech.abort(); return { ok: true, providerMessageId: "wamid.accepted", outcome: "verified_success", dispatched: true }; });
  const result = await deliverCallingQuotation({ ...request, db: fixture.db, signal: speech.signal, execution: { signal: execution.signal } });
  expect(result.ok).toBe(true); expect(execution.signal.aborted).toBe(false);
  expect(fixture.tables.messages![0]).toMatchObject({ delivery_status: "sent", provider_message_id: "wamid.accepted" });
  expect(fixture.tables.ai_tasks![0].status).toBe("completed");
});

it("reconciles already-persisted message evidence without re-sending after task-result persistence failed", async () => {
  const fixture = callingDb(); const execution = { signal: new AbortController().signal };
  mocks.send.mockResolvedValue({ ok: true, providerMessageId: "wamid.accepted", outcome: "verified_success", dispatched: true });
  let failOnce = true;
  const baseFrom = fixture.db.from.bind(fixture.db);
  const db = { from(table: string) {
    const query = baseFrom(table);
    if (table === "ai_tasks") {
      const update = query.update;
      query.update = (value: { status?: string }) => {
        if (value.status === "completed" && failOnce) { failOnce = false; fixture.failures.set("ai_tasks:update", { code: "synthetic_failure" }); }
        else fixture.failures.delete("ai_tasks:update");
        return update(value);
      };
    }
    return query;
  } };
  const first = await deliverCallingQuotation({ ...request, db, execution });
  expect(first).toMatchObject({ ok: false, outcome: "outcome_unknown", providerEvidence: { providerMessageId: "wamid.accepted" } });
  expect(fixture.tables.messages).toHaveLength(1);
  const reconciled = await deliverCallingQuotation({ ...request, db, execution });
  expect(reconciled.ok).toBe(true); expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(fixture.tables.ai_tasks![0].status).toBe("completed");
});
