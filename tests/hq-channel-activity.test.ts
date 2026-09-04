import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildCallObservability,
  buildChannelActivity,
  maskPhone,
  normalizeCallStatus,
  normalizeMessageChannel,
  normalizeMessageStatus,
} from "@/lib/hq/hq.core";

const callRow = (overrides: Record<string, unknown> = {}) => ({
  id: "call-id",
  agency_id: "a1",
  lead_id: null,
  conversation_id: null,
  caller_phone: "+60123456789",
  direction: "inbound",
  status: "ringing",
  termination_reason: null,
  received_at: "2026-09-01T12:00:00Z",
  answer_requested_at: null,
  meta_accepted_at: null,
  media_negotiated_at: null,
  media_ready_at: null,
  answered_at: null,
  ended_at: null,
  turn_count: 0,
  detected_language: null,
  voice_outcome: null,
  closing_state: null,
  call_summary: null,
  voice_latency: [],
  ...overrides,
});

const agencyNames = new Map([["a1", "Alpha Travel"]]);

const conversations = [
  { id: "c1", lead_id: "l1", channel: "whatsapp", human_attention_required: false },
  { id: "c2", lead_id: null, channel: "whatsapp", human_attention_required: true },
];

const leads = [{ id: "l1", full_name: "Ahmad", phone: "+60123456789", do_not_contact: false }];

const messages = [
  {
    id: "m1",
    agency_id: "a1",
    conversation_id: "c1",
    sender: "customer",
    modality: "text",
    delivery_status: "sent",
    created_at: "2026-09-01T10:00:00Z",
  },
  {
    id: "m2",
    agency_id: "a1",
    conversation_id: "c1",
    sender: "customer",
    modality: "audio",
    delivery_status: "sent",
    created_at: "2026-09-01T11:00:00Z",
  },
  {
    id: "m3",
    agency_id: "a1",
    conversation_id: "c2",
    sender: "human",
    modality: "text",
    delivery_status: "failed",
    created_at: "2026-09-01T09:00:00Z",
  },
  {
    id: "m4",
    agency_id: "a1",
    conversation_id: "c1",
    sender: "customer",
    modality: "image",
    delivery_status: "sent",
    created_at: "2026-09-01T08:00:00Z",
  },
];

const calls = [
  {
    id: "k1",
    agency_id: "a1",
    lead_id: "l1",
    caller_phone: "+60123456789",
    direction: "inbound",
    status: "terminated",
    termination_reason: "completed",
    received_at: "2026-09-01T12:00:00Z",
    answered_at: "2026-09-01T12:00:05Z",
    ended_at: "2026-09-01T12:01:00Z",
    turn_count: 3,
  },
  {
    id: "k2",
    agency_id: "zz",
    lead_id: null,
    caller_phone: null,
    direction: "inbound",
    status: "failed",
    termination_reason: "gateway_http_502",
    received_at: "2026-09-01T07:00:00Z",
    answered_at: null,
    ended_at: null,
    turn_count: 0,
  },
];

describe("HQ channel normalization", () => {
  it("maps modality to channels and ignores out-of-scope modalities", () => {
    expect(normalizeMessageChannel("text")).toBe("WHATSAPP_TEXT");
    expect(normalizeMessageChannel(null)).toBe("WHATSAPP_TEXT");
    expect(normalizeMessageChannel("audio")).toBe("VOICE_NOTE");
    expect(normalizeMessageChannel("image")).toBeNull();
  });

  it("derives message status from event-level delivery evidence only", () => {
    // sent proves provider send/accept only — never SUCCESS.
    expect(normalizeMessageStatus("sent")).toBe("PARTIAL");
    expect(normalizeMessageStatus("read")).toBe("SUCCESS");
    expect(normalizeMessageStatus("delivered")).toBe("SUCCESS");
    expect(normalizeMessageStatus("failed")).toBe("FAILED");
    expect(normalizeMessageStatus("pending")).toBe("PENDING");
    expect(normalizeMessageStatus("queued")).toBe("PENDING");
    expect(normalizeMessageStatus(null)).toBe("UNKNOWN");
  });

  it("derives call status from lifecycle evidence", () => {
    expect(
      normalizeCallStatus({
        status: "terminated",
        termination_reason: "completed",
        answered_at: "x",
      }),
    ).toBe("SUCCESS");
    expect(
      normalizeCallStatus({
        status: "terminated",
        termination_reason: "completed",
        answered_at: null,
      }),
    ).toBe("PARTIAL");
    expect(
      normalizeCallStatus({
        status: "terminated",
        termination_reason: "session_timeout",
        answered_at: "x",
      }),
    ).toBe("PARTIAL");
    expect(
      normalizeCallStatus({ status: "failed", termination_reason: "failed", answered_at: null }),
    ).toBe("FAILED");
    expect(
      normalizeCallStatus({ status: "weird", termination_reason: null, answered_at: null }),
    ).toBe("UNKNOWN");
  });

  it("masks customer phone numbers", () => {
    expect(maskPhone("+60123456789")).toBe("••••6789");
    expect(maskPhone(null)).toBe("Unresolved");
  });
});

describe("HQ channel activity feed", () => {
  const items = buildChannelActivity({ messages, conversations, calls, leads, agencyNames });

  it("merges channels newest first and drops unsupported modalities", () => {
    expect(items.map((i) => i.id)).toEqual(["call:k1", "msg:m2", "msg:m1", "msg:m3", "call:k2"]);
  });

  it("resolves attribution and fails safe when unknown", () => {
    const call = items.find((i) => i.id === "call:k1")!;
    expect(call.agencyName).toBe("Alpha Travel");
    expect(call.contactName).toBe("Ahmad");
    const orphan = items.find((i) => i.id === "call:k2")!;
    expect(orphan.agencyName).toBe("Unresolved");
    expect(orphan.contactName).toBe("Unresolved");
    expect(orphan.contactPhone).toBe("Unresolved");
    expect(items.find((i) => i.id === "msg:m3")!.contactName).toBe("Unresolved");
  });

  it("never exposes message bodies and respects limits", () => {
    for (const i of items) expect(i.summary).not.toMatch(/salam|hello/i);
    expect(
      buildChannelActivity({ messages, conversations, calls, leads, agencyNames, limit: 2 }),
    ).toHaveLength(2);
  });

  it("keeps delivery-derived status even if the lead is currently do_not_contact", () => {
    const result = buildChannelActivity({
      messages: [{ ...messages[0]!, id: "m9", sender: "ai", delivery_status: "delivered" }],
      conversations,
      calls: [],
      leads: [{ ...leads[0]!, do_not_contact: true }],
      agencyNames,
    });
    // No event-level blocked evidence exists, so current DNC must not
    // retroactively rewrite history.
    expect(result[0]!.interactionStatus).toBe("SUCCESS");
    expect(result[0]!.interactionStatus).not.toBe("BLOCKED");
  });

  it("does not retroactively apply conversation human_attention_required to old messages", () => {
    const result = buildChannelActivity({
      messages: [
        {
          ...messages[0]!,
          id: "m10",
          conversation_id: "c2", // human_attention_required = true (current state)
          delivery_status: "read",
        },
      ],
      conversations,
      calls: [],
      leads,
      agencyNames,
    });
    expect(result[0]!.interactionStatus).toBe("SUCCESS");
    expect(result[0]!.interactionStatus).not.toBe("HUMAN_REQUIRED");
  });
});

describe("Founder HQ call observability", () => {
  it.each([
    ["received/ringing", { status: "ringing" }, "RECEIVED"],
    ["negotiating", { status: "media_negotiating", meta_accepted_at: "2026-09-01T12:00:02Z" }, "NEGOTIATING"],
    ["media ready", { status: "media_negotiating", media_ready_at: "2026-09-01T12:00:03Z" }, "MEDIA_READY"],
    ["answered", { status: "answered", answered_at: "2026-09-01T12:00:04Z" }, "ANSWERED"],
    ["normally ended", { status: "terminated", termination_reason: "completed", ended_at: "2026-09-01T12:01:00Z" }, "ENDED"],
    ["failed", { status: "failed", termination_reason: "gateway_error" }, "FAILED"],
    ["unknown/incomplete", { status: "unexpected" }, "UNKNOWN"],
  ])("represents %s calls", (_label, patch, expected) => {
    expect(buildCallObservability(callRow(patch) as never).operationalState).toBe(expected);
  });

  it("reports linkage and memory evidence without exposing memory content", () => {
    const absent = buildCallObservability(callRow() as never);
    expect(absent).toMatchObject({
      leadLinked: false,
      conversationLinked: false,
      callSummaryPresent: false,
      memoryContinuity: "ABSENT",
    });
    const linked = buildCallObservability(
      callRow({ lead_id: "lead-1", conversation_id: "conv-1", call_summary: "private summary" }) as never,
    );
    expect(linked).toMatchObject({
      leadLinked: true,
      conversationLinked: true,
      callSummaryPresent: true,
      memoryContinuity: "PRESENT",
    });
    expect(JSON.stringify(linked)).not.toContain("private summary");
  });

  it("derives duration only from valid answered and ended timestamps", () => {
    expect(buildCallObservability(callRow({ answered_at: "2026-09-01T12:00:05Z", ended_at: "2026-09-01T12:01:00Z" }) as never).durationSeconds).toBe(55);
    expect(buildCallObservability(callRow({ answered_at: "bad", ended_at: "2026-09-01T12:01:00Z" }) as never).durationSeconds).toBeNull();
  });

  it("summarizes valid latency and fails safely for absent or malformed telemetry", () => {
    const observed = buildCallObservability(callRow({ voice_latency: [
      { asr_ms: 100, context_ms: 20, reasoning_ms: 200, tts_ms: 80, total_ms: 400 },
      { asr_ms: 300, context_ms: 40, reasoning_ms: 600, tts_ms: 160, total_ms: 1100 },
    ] }) as never);
    expect(observed.latency.asr).toEqual({ p50: 100, p95: 300, samples: 2 });
    expect(observed.latency.total?.p95).toBe(1100);
    expect(buildCallObservability(callRow({ voice_latency: null }) as never).latency.total).toBeNull();
    expect(buildCallObservability(callRow({ voice_latency: [{ total_ms: "secret" }, null, -1] }) as never).latency.total).toBeNull();
  });

  it("exposes metadata only: no transcript, summary text, message body, audio, or full phone", () => {
    const raw = callRow({
      caller_phone: "+60123456789",
      call_summary: "PRIVATE SUMMARY",
      transcript: [{ text: "PRIVATE TRANSCRIPT" }],
      audio: "RAW AUDIO",
      message_body: "PRIVATE MESSAGE",
    });
    const publicItem = buildChannelActivity({ messages: [], conversations: [], calls: [raw as never], leads: [], agencyNames })[0]!;
    const serialized = JSON.stringify(publicItem);
    expect(publicItem.contactPhone).toBe("••••6789");
    expect(serialized).not.toMatch(/60123456789|PRIVATE SUMMARY|PRIVATE TRANSCRIPT|RAW AUDIO|PRIVATE MESSAGE/);
  });
});

describe("Founder HQ call observability boundary", () => {
  const source = readFileSync("src/lib/hq/hq.functions.ts", "utf8");
  const handler = source.slice(source.indexOf("export const getHqChannelActivity"));

  it("keeps platform_owner authorization on the server before privileged reads", () => {
    expect(handler).toContain('createServerFn({ method: "GET" })');
    expect(handler).toContain(".middleware([requireSupabaseAuth])");
    expect(handler.indexOf("await assertPlatformOwner")).toBeGreaterThan(-1);
    expect(handler.indexOf("await assertPlatformOwner")).toBeLessThan(
      handler.indexOf("supabaseAdmin"),
    );
  });

  it("remains read-only and does not select private payload columns", () => {
    expect(handler).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(handler).not.toMatch(/select\([^)]*(transcript|audio|message_body)/s);
  });
});
