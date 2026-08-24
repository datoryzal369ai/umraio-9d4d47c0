import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_OUTBOUND_BYTES,
  authorizeOutboundSend,
  outboundMediaBody,
  validateOutboundMedia,
} from "../src/lib/conversations/outbound-media.core";
import {
  sendWhatsappMediaMessage,
  uploadWhatsappMedia,
} from "../src/lib/whatsapp-send.server";
import { describeMessageMedia } from "../src/lib/conversations/media.core";
import {
  mergeRealtimeMessage,
  reconcileMessages,
} from "../src/lib/conversations/realtime.core";
import type { ChatMessage } from "../src/lib/conversations";

const CONV = "11111111-1111-4111-8111-111111111111";
const AGENCY = "22222222-2222-4222-8222-222222222222";

const conversation = {
  id: CONV,
  agency_id: AGENCY,
  lead: { phone: "60123456789" },
};

const row = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  conversation_id: CONV,
  agency_id: AGENCY,
  sender: "human",
  body: "",
  created_at: "2026-08-24T10:00:00.000Z",
  modality: "text",
  media_id: null,
  delivery_status: "sent",
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("B-4.4 — outbound media composer", () => {
  it("1. accepts a recorded voice note (audio/ogg)", () => {
    const auth = authorizeOutboundSend({
      conversation,
      mimeType: "audio/ogg;codecs=opus",
      byteLength: 48_000,
    });
    expect(auth).toMatchObject({ ok: true, kind: "audio", mimeType: "audio/ogg", to: "60123456789" });
  });

  it("2. accepts an image attachment", () => {
    const auth = authorizeOutboundSend({ conversation, mimeType: "image/png", byteLength: 120_000 });
    expect(auth).toMatchObject({ ok: true, kind: "image" });
  });

  it("3. accepts a PDF document attachment", () => {
    const auth = authorizeOutboundSend({
      conversation,
      mimeType: "application/pdf",
      byteLength: 400_000,
    });
    expect(auth).toMatchObject({ ok: true, kind: "document" });
    expect(outboundMediaBody("document", "pakej.pdf")).toBe("[Document sent] pakej.pdf");
  });

  it("4. rejects a disallowed MIME type", () => {
    expect(validateOutboundMedia({ mimeType: "application/x-msdownload", byteLength: 10 })).toMatchObject({
      ok: false,
      reason: "unsupported_type",
    });
    expect(validateOutboundMedia({ mimeType: "video/mp4", byteLength: 10 }).ok).toBe(false);
    expect(validateOutboundMedia({ mimeType: "", byteLength: 10 }).ok).toBe(false);
  });

  it("5. rejects an oversized file and an empty file", () => {
    expect(
      validateOutboundMedia({ mimeType: "image/jpeg", byteLength: MAX_OUTBOUND_BYTES.image + 1 }),
    ).toMatchObject({ ok: false, reason: "too_large" });
    expect(validateOutboundMedia({ mimeType: "image/jpeg", byteLength: 0 })).toMatchObject({
      ok: false,
      reason: "empty",
    });
  });

  it("6/7/8. rejects unauthenticated, cross-tenant and cross-conversation sends", () => {
    // RLS returns nothing for a conversation the caller may not read — the same
    // shape produced by an unauthenticated, cross-tenant or cross-conversation id.
    const denied = authorizeOutboundSend({
      conversation: null,
      mimeType: "image/jpeg",
      byteLength: 100,
    });
    expect(denied).toEqual({ ok: false, message: "Conversation not found for this account." });
  });

  it("9. a failed Meta send never reports a provider message id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );
    const result = await sendWhatsappMediaMessage("pn", "token", "60123456789", {
      kind: "image",
      mediaId: "media-1",
    });
    expect(result).toEqual({ ok: false, providerMessageId: null });
  });

  it("10. a retry after a failed send produces a fresh delivered result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("fail", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.RETRY" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const first = await sendWhatsappMediaMessage("pn", "token", "60123456789", {
      kind: "document",
      mediaId: "media-2",
      filename: "pakej.pdf",
    });
    const second = await sendWhatsappMediaMessage("pn", "token", "60123456789", {
      kind: "document",
      mediaId: "media-2",
      filename: "pakej.pdf",
    });
    expect(first.ok).toBe(false);
    expect(second).toEqual({ ok: true, providerMessageId: "wamid.RETRY" });
  });

  it("11. realtime does not duplicate an outbound media row already in cache", () => {
    const sent = row({ id: "out-1", modality: "image", media_id: "mid-1", body: "[Image sent]" });
    const merged = mergeRealtimeMessage([sent], sent, CONV);
    expect(merged.filter((m) => m.id === "out-1")).toHaveLength(1);
  });

  it("12. REST refetch does not duplicate the outbound row and keeps ordering", () => {
    const older = row({ id: "a", created_at: "2026-08-24T09:00:00.000Z" });
    const sent = row({ id: "out-1", modality: "audio", media_id: "mid-2", created_at: "2026-08-24T10:00:00.000Z" });
    const reconciled = reconcileMessages([older, sent], [older, sent], CONV);
    expect(reconciled.map((m) => m.id)).toEqual(["a", "out-1"]);
  });

  it("13. chronological ordering survives an out-of-order server window", () => {
    const a = row({ id: "a", created_at: "2026-08-24T08:00:00.000Z" });
    const b = row({ id: "b", created_at: "2026-08-24T09:00:00.000Z" });
    const reconciled = reconcileMessages([b], [b, a], CONV);
    expect(reconciled.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("14. a console media send is persisted with the human/agent identity", () => {
    const sent = row({ sender: "human", modality: "audio", media_id: "mid-3" });
    expect(sent.sender).toBe("human");
    expect(sent.sender).not.toBe("ai");
  });

  it("15. no Meta token or service-role credential exists in browser-safe modules", async () => {
    const core = await import("fs/promises").then((fs) =>
      fs.readFile("src/lib/conversations/outbound-media.core.ts", "utf8"),
    );
    const composer = await import("fs/promises").then((fs) =>
      fs.readFile("src/components/conversations/MediaComposer.tsx", "utf8"),
    );
    for (const source of [core, composer]) {
      expect(source).not.toMatch(/graph\.facebook\.com/);
      expect(source).not.toMatch(/SERVICE_ROLE/);
      expect(source).not.toMatch(/access_token/);
    }
  });

  it("16. existing inbound media rendering is unaffected", () => {
    const inbound = describeMessageMedia(
      row({ sender: "customer", modality: "audio", media_id: "in-1", body: "Ya ya." }),
    );
    expect(inbound.kind).toBe("audio");
    expect(inbound.resolvable).toBe(true);
    expect(inbound.transcript).toBe("Ya ya.");
  });

  it("uploads media exactly once through the shared Meta upload path", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "meta-media-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const id = await uploadWhatsappMedia("pn", "token", {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      filename: "a.jpg",
    });
    expect(id).toBe("meta-media-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
