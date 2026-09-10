import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/whatsapp-send.server", () => ({ sendWhatsappTextDetailed: mocks.send }));
import { CALL_QUOTATION_TOOL, deliverCallingQuotation, quotationDeliveryReply } from "@/lib/calls/call-quotation.server";
import { callingDb } from "./helpers/calling-worker-db";

const request = { agencyId: "agency", callId: "synthetic-call", sequence: 8, transcript: "Hantar quotation sekarang dekat WhatsApp, boleh?", leadId: "lead", conversationId: "conversation", quotationId: "quotation" };
beforeEach(() => { mocks.send.mockReset(); mocks.send.mockResolvedValue({ ok: true, providerMessageId: "wamid.synthetic" }); });

describe("Calling governed quotation delivery", () => {
  it("invokes the existing tool registry and central sender, persists the verified receipt, then permits completion language", async () => {
    const fixture = callingDb();
    const result = await deliverCallingQuotation({ ...request, db: fixture.db });
    expect(result.ok).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]!.slice(0, 3)).toEqual(["synthetic-phone", "synthetic-test-only", "60123456789"]);
    expect(mocks.send.mock.calls[0]![3]).toContain("Q-TEST-0007");
    expect(mocks.send.mock.calls[0]![3]).toContain("/q/synthetic-document");
    expect(fixture.tables.messages).toEqual([expect.objectContaining({ delivery_status: "sent", provider_message_id: "wamid.synthetic", agency_id: "agency", conversation_id: "conversation" })]);
    expect(fixture.tables.ai_tasks).toEqual([expect.objectContaining({ kind: CALL_QUOTATION_TOOL, status: "completed", output: expect.objectContaining({ providerMessageId: "wamid.synthetic" }) })]);
    expect(fixture.tables.activity_log!.map(r => r.meta.event)).toEqual(["TOOL_REQUEST", "ACTION_EXECUTED"]);
    expect(quotationDeliveryReply(result, "ms")).toContain("sudah dihantar");
    expect(fixture.tables.quotations![0].status).toBe("deposit_paid");
    expect(fixture.tables.bookings![0].status).toBe("deposit_paid");
    expect(fixture.operations.filter(op => op.kind !== "select").every(op => ["ai_tasks", "activity_log", "messages", "conversations"].includes(op.table))).toBe(true);
  });

  it("uses an atomic claim for concurrent retries and reuses a saved receipt", async () => {
    const fixture = callingDb();
    const results = await Promise.all([deliverCallingQuotation({ ...request, db: fixture.db }), deliverCallingQuotation({ ...request, db: fixture.db })]);
    expect(results.some(r => r.ok)).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const retry = await deliverCallingQuotation({ ...request, db: fixture.db });
    expect(retry.ok).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(fixture.tables.messages).toHaveLength(1);
  });

  it.each(["wrong_caller", "wrong_agency", "wrong_quotation_owner", "do_not_contact", "muted", "human_takeover", "missing_config", "terminal", "draft"])("fails closed for %s without dispatch", async reason => {
    const fixture = callingDb();
    if (reason === "wrong_caller") fixture.tables.whatsapp_call_sessions![0].caller_phone = "60199999999";
    if (reason === "wrong_agency") fixture.tables.conversations![0].agency_id = "other";
    if (reason === "wrong_quotation_owner") fixture.tables.quotations![0].lead_id = "other";
    if (reason === "do_not_contact") fixture.tables.leads![0].do_not_contact = true;
    if (reason === "muted") fixture.tables.conversations![0].ai_enabled = false;
    if (reason === "human_takeover") fixture.tables.conversations![0].human_attention_required = true;
    if (reason === "missing_config") fixture.tables.whatsapp_configs = [];
    if (reason === "terminal") fixture.tables.whatsapp_call_sessions![0].status = "completed";
    if (reason === "draft") fixture.tables.quotations![0].status = "draft";
    const result = await deliverCallingQuotation({ ...request, db: fixture.db });
    expect(result.ok).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(quotationDeliveryReply(result, "ms")).not.toMatch(/sudah dihantar|akan hantar/);
    expect(fixture.tables.activity_log!.at(-1).meta.event).toBe("ACTION_FAILED");
  });

  it.each([{ ok: false, providerMessageId: null }, { ok: true, providerMessageId: null }])("does not mistake HTTP success or failed dispatch for verified execution: %j", async send => {
    mocks.send.mockResolvedValue(send);
    const fixture = callingDb();
    const result = await deliverCallingQuotation({ ...request, db: fixture.db });
    expect(result.ok).toBe(false);
    expect(fixture.tables.messages![0].delivery_status).toBe("send_failed");
    expect(fixture.tables.ai_tasks![0].status).toBe("failed");
    expect(quotationDeliveryReply(result, "ms")).toContain("belum boleh sahkan");
    await deliverCallingQuotation({ ...request, db: fixture.db });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each(["ai_tasks:insert", "messages:insert", "ai_tasks:update"])("does not claim completion if persistence fails at %s", async stage => {
    const fixture = callingDb(); fixture.failures.set(stage, { code: "unavailable" });
    const result = await deliverCallingQuotation({ ...request, db: fixture.db });
    expect(result.ok).toBe(false);
    expect(quotationDeliveryReply(result, "en")).toContain("can't confirm");
    expect(mocks.send).toHaveBeenCalledTimes(stage === "ai_tasks:insert" ? 0 : 1);
  });

  it("does not send after cancellation, but preserves an in-flight dispatch result when caller hangs up", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const fixture = callingDb();
    expect((await deliverCallingQuotation({ ...request, db: fixture.db, signal: cancelled.signal })).ok).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    const active = new AbortController();
    mocks.send.mockImplementation(async () => { active.abort(); return { ok: true, providerMessageId: "wamid.synthetic" }; });
    const result = await deliverCallingQuotation({ ...request, db: fixture.db, signal: active.signal });
    expect(result.ok).toBe(true);
    expect(fixture.tables.ai_tasks![0].status).toBe("completed");
  });

  it("does not invoke a tool for an implicit, future or redirected request", async () => {
    const fixture = callingDb();
    for (const transcript of ["Berapa quotation saya?", "Hantar quotation esok", "Hantar quotation pada isteri"]) {
      expect((await deliverCallingQuotation({ ...request, db: fixture.db, transcript })).ok).toBe(false);
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect(fixture.operations).toHaveLength(0);
  });
  it("does not substitute the latest quotation for a different explicit reference", async () => {
    const fixture = callingDb();
    const result = await deliverCallingQuotation({ ...request, db: fixture.db, transcript: "Hantar quotation Q-TEST-0008 ke WhatsApp" });
    expect(result).toEqual({ ok: false, reason: "requested_quotation_mismatch" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
