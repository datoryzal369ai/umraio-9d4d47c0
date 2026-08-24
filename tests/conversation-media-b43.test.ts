import { describe, expect, it } from "vitest";

import {
  describeMessageMedia,
  formatDuration,
  isRenderableMime,
  mediaKindLabel,
  mediaKindOf,
  normalizeMime,
} from "../src/lib/conversations/media.core";
import {
  mergeRealtimeMessage,
  reconcileMessages,
} from "../src/lib/conversations/realtime.core";
import type { ChatMessage } from "../src/lib/conversations";

const CONV = "conv-1";

const row = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  conversation_id: CONV,
  agency_id: "agency-1",
  sender: "customer",
  body: "",
  created_at: "2026-08-24T09:00:00.000Z",
  modality: "text",
  media_id: null,
  delivery_status: "sent",
  ...over,
});

describe("B-4.3 — read-only media rendering", () => {
  it("A. renders an existing inbound voice note with its transcript", () => {
    const d = describeMessageMedia(
      row({ modality: "audio", media_id: "2264454964347118", body: "Ya ya ya ya." }),
    );
    expect(d.kind).toBe("audio");
    expect(d.resolvable).toBe(true);
    expect(d.transcript).toBe("Ya ya ya ya.");
    expect(d.status).toBeNull();
  });

  it("B. renders an existing inbound image with its grounded caption", () => {
    const d = describeMessageMedia(
      row({
        modality: "image",
        media_id: "1646917217077396",
        body: "[Gambar daripada pelanggan] Malaysian identity card (MyKad).",
      }),
    );
    expect(d.kind).toBe("image");
    expect(d.resolvable).toBe(true);
    expect(d.caption).toBe("Malaysian identity card (MyKad).");
  });

  it("C. renders a PDF document row with filename and type", () => {
    const d = describeMessageMedia(
      row({ modality: "document", media_id: "doc-1", body: "pakej-umrah.pdf" }),
    );
    expect(d.kind).toBe("document");
    expect(d.filename).toBe("pakej-umrah.pdf");
    expect(mediaKindLabel(d.kind)).toBe("Document");
  });

  it("D. transcript is omitted and a status shown when transcription failed", () => {
    const d = describeMessageMedia(row({ modality: "audio", media_id: "a1", body: "" }));
    expect(d.transcript).toBeNull();
    expect(d.status).toBe("Voice note received — transcription unavailable");
  });

  it("E. unsupported/expired media degrades to a safe fallback card", () => {
    const expired = describeMessageMedia(row({ modality: "image", media_id: null, body: "x" }));
    expect(expired.resolvable).toBe(false);
    expect(expired.status).toContain("Media received");

    const unknown = describeMessageMedia(row({ modality: "sticker", media_id: "s1" }));
    expect(unknown.kind).toBe("unknown");
    expect(mediaKindLabel(unknown.kind)).toBe("Media received");
    expect(unknown.status).toBeTruthy();
  });

  it("E2. MIME validation rejects anything outside the allow-list", () => {
    expect(isRenderableMime("image", "image/png")).toBe(true);
    expect(isRenderableMime("image", "IMAGE/JPEG; charset=binary")).toBe(true);
    expect(isRenderableMime("image", "text/html")).toBe(false);
    expect(isRenderableMime("audio", "audio/ogg; codecs=opus")).toBe(true);
    expect(isRenderableMime("document", "application/pdf")).toBe(true);
    expect(isRenderableMime("document", "application/x-msdownload")).toBe(false);
    expect(isRenderableMime("unknown", "image/png")).toBe(false);
    expect(normalizeMime(null)).toBe("");
  });

  it("F. a new media message arriving through realtime is merged into the timeline", () => {
    const current = [row({ id: "t1", body: "Salam", created_at: "2026-08-24T09:00:00.000Z" })];
    const incoming = row({
      id: "v1",
      modality: "audio",
      media_id: "a1",
      body: "Terima kasih",
      created_at: "2026-08-24T09:01:00.000Z",
    });
    const next = mergeRealtimeMessage(current, incoming, CONV);
    expect(next).toHaveLength(2);
    expect(describeMessageMedia(next[1]!).kind).toBe("audio");
  });

  it("G. media stays visible after a refetch that does not include it", () => {
    const cache = [
      row({ id: "t1", created_at: "2026-08-24T09:00:00.000Z", body: "Salam" }),
      row({
        id: "v1",
        modality: "audio",
        media_id: "a1",
        created_at: "2026-08-24T09:01:00.000Z",
        body: "Terima kasih",
      }),
    ];
    const serverWindow = [cache[0]!];
    const next = reconcileMessages(cache, serverWindow, CONV);
    expect(next.map((m) => m.id)).toEqual(["t1", "v1"]);
    expect(next[1]!.media_id).toBe("a1");
  });

  it("H. realtime + REST delivering the same media row does not duplicate it", () => {
    const media = row({ id: "v1", modality: "image", media_id: "i1", body: "[img] resit" });
    const afterRealtime = mergeRealtimeMessage([], media, CONV);
    const afterRefetch = reconcileMessages(afterRealtime, [media], CONV);
    expect(afterRefetch).toHaveLength(1);
    expect(afterRefetch[0]!.media_id).toBe("i1");
  });

  it("I. media from another conversation is rejected client-side", () => {
    const foreign = row({ id: "v9", conversation_id: "conv-2", modality: "image", media_id: "i9" });
    expect(mergeRealtimeMessage([], foreign, CONV)).toHaveLength(0);
    expect(reconcileMessages([foreign], [], CONV)).toHaveLength(0);
  });

  it("L. text messages are unaffected by media rendering", () => {
    const d = describeMessageMedia(row({ body: "Assalamualaikum" }));
    expect(d.kind).toBe("text");
    expect(d.resolvable).toBe(false);
    expect(d.transcript).toBeNull();
    expect(mediaKindOf(undefined)).toBe("text");
  });

  it("duration formatting is defensive", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(null)).toBeNull();
  });
});
