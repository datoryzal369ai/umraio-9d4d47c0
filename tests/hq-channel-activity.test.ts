import { describe, expect, it } from "vitest";

import {
  buildChannelActivity,
  maskPhone,
  normalizeCallStatus,
  normalizeMessageChannel,
  normalizeMessageStatus,
} from "@/lib/hq/hq.core";

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

  it("derives message status from delivery evidence only", () => {
    expect(normalizeMessageStatus("sent", false)).toBe("SUCCESS");
    expect(normalizeMessageStatus("failed", false)).toBe("FAILED");
    expect(normalizeMessageStatus(null, false)).toBe("UNKNOWN");
    expect(normalizeMessageStatus("sent", true)).toBe("HUMAN_REQUIRED");
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

  it("marks outbound activity to DNC leads as blocked", () => {
    const blocked = buildChannelActivity({
      messages: [{ ...messages[0]!, id: "m9", sender: "ai" }],
      conversations,
      calls: [],
      leads: [{ ...leads[0]!, do_not_contact: true }],
      agencyNames,
    });
    expect(blocked[0]!.interactionStatus).toBe("BLOCKED");
  });
});
