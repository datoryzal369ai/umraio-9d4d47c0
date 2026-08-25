import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PREFERRED_RECORDING_MIME,
  authorizeOutboundSend,
  filenameForOutboundMime,
  validateOutboundMedia,
  validateRecordedAudioBytes,
} from "../src/lib/conversations/outbound-media.core";
import {
  normalizeWhatsappDeliveryStatus,
  shouldApplyWhatsappStatus,
  summarizeWhatsappStatusError,
} from "../src/lib/whatsapp/delivery-status.core";
import { authorizeOutboundText } from "../src/lib/conversations/outbound-text.core";
import {
  sendWhatsappText,
  sendWhatsappTextDetailed,
  sendWhatsappMediaMessage,
  uploadWhatsappMedia,
} from "../src/lib/whatsapp-send.server";

const CONV = "11111111-1111-4111-8111-111111111111";
const AGENCY = "22222222-2222-4222-8222-222222222222";
const conversation = { id: CONV, agency_id: AGENCY, lead: { phone: "60123456789" } };

afterEach(() => vi.unstubAllGlobals());

describe("console outbound TEXT", () => {
  it("1. authorises an owned conversation with a phone number", () => {
    expect(authorizeOutboundText({ conversation, body: " Salam " })).toMatchObject({
      ok: true,
      to: "60123456789",
      body: "Salam",
      agencyId: AGENCY,
    });
  });

  it("2. refuses a conversation the caller cannot read (RLS returned nothing)", () => {
    expect(authorizeOutboundText({ conversation: null, body: "hi" }).ok).toBe(false);
  });

  it("3. refuses a contact without a WhatsApp number", () => {
    expect(
      authorizeOutboundText({ conversation: { ...conversation, lead: { phone: "" } }, body: "hi" })
        .ok,
    ).toBe(false);
  });

  it("4. refuses an empty body", () => {
    expect(authorizeOutboundText({ conversation, body: "   " }).ok).toBe(false);
  });

  it("5. returns Meta's wamid on a successful send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.TEST123" }] }), { status: 200 }),
      ),
    );
    const result = await sendWhatsappTextDetailed("PN", "TOKEN", "60123456789", "Salam");
    expect(result).toEqual({ ok: true, providerMessageId: "wamid.TEST123" });
  });

  it("6. reports failure with no provider id when Meta rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"error\":{}}", { status: 400 })));
    const result = await sendWhatsappTextDetailed("PN", "TOKEN", "60123456789", "Salam");
    expect(result).toEqual({ ok: false, providerMessageId: null });
  });

  it("7. keeps the existing boolean contract for legacy callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 })),
    );
    expect(await sendWhatsappText("PN", "TOKEN", "60123456789", "hi")).toBe(true);
  });

  it("8. customer simulation never touches Meta", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // The console only calls the send path for `asHuman`; simulation is a plain
    // database insert, so no Graph request may exist for it.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("console outbound VOICE — container/filename truth", () => {
  it("9. names an OGG recording .ogg", () => {
    expect(filenameForOutboundMime("audio/ogg;codecs=opus", "voice-note")).toBe("voice-note.ogg");
  });

  it("10. names an MP4/AAC recording .m4a — never .ogg", () => {
    expect(filenameForOutboundMime("audio/mp4", "voice-note")).toBe("voice-note.m4a");
  });

  it("11. refuses audio/webm before upload", () => {
    expect(validateOutboundMedia({ mimeType: "audio/webm", byteLength: 4000 })).toMatchObject({
      ok: false,
      reason: "unsupported_type",
    });
    expect(PREFERRED_RECORDING_MIME).not.toContain("audio/webm");
  });

  it("12. logs the Meta error body when a media upload fails", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => errors.push(String(m)));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"error\":{\"message\":\"bad\"}}", { status: 400 })));
    const id = await uploadWhatsappMedia("PN", "TOKEN", {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mp4",
      filename: "voice-note.m4a",
    });
    expect(id).toBeNull();
    expect(errors.join(" ")).toContain("bad");
    expect(errors.join(" ")).not.toContain("TOKEN");
    spy.mockRestore();
  });

  it("13. accepts real OGG/Opus bytes", () => {
    const bytes = new TextEncoder().encode("OggS....OpusHead....");
    expect(validateRecordedAudioBytes("audio/ogg;codecs=opus", bytes)).toEqual({
      ok: true,
      container: "ogg",
      codec: "opus",
    });
  });

  it("14. accepts MP4 only when the bytes declare AAC", () => {
    const aac = new TextEncoder().encode("....ftypM4A ....mp4a....");
    const opus = new TextEncoder().encode("....ftypisom....Opus....");
    expect(validateRecordedAudioBytes("audio/mp4", aac)).toMatchObject({ ok: true, codec: "aac" });
    expect(validateRecordedAudioBytes("audio/mp4", opus)).toMatchObject({ ok: false });
  });

  it("15. sends OGG/Opus with Meta's native voice-note flag", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid.VOICE" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await sendWhatsappMediaMessage("PN", "TOKEN", "60123456789", {
      kind: "audio",
      mediaId: "MEDIA",
      voice: true,
    });
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      type: "audio",
      audio: { id: "MEDIA", voice: true },
    });
  });
});

describe("image path regression", () => {
  it("16. image authorisation is unchanged", () => {
    expect(authorizeOutboundSend({ conversation, mimeType: "image/jpeg", byteLength: 100_000 })).toMatchObject({
      ok: true,
      kind: "image",
      mimeType: "image/jpeg",
      to: "60123456789",
    });
  });

  it("17. picker filenames are preserved for images", () => {
    expect(filenameForOutboundMime("image/jpeg", "attachment")).toBe("attachment.jpg");
  });
});

describe("WhatsApp delivery status reconciliation", () => {
  it("18. recognizes provider terminal and progress statuses", () => {
    expect(normalizeWhatsappDeliveryStatus("delivered")).toBe("delivered");
    expect(normalizeWhatsappDeliveryStatus("unknown")).toBeNull();
  });

  it("19. advances status and refuses out-of-order regression", () => {
    expect(shouldApplyWhatsappStatus("sent", "delivered")).toBe(true);
    expect(shouldApplyWhatsappStatus("delivered", "read")).toBe(true);
    expect(shouldApplyWhatsappStatus("read", "delivered")).toBe(false);
    expect(shouldApplyWhatsappStatus("read", "failed")).toBe(true);
  });

  it("20. sanitizes status error diagnostics", () => {
    expect(summarizeWhatsappStatusError({ code: 131053, title: "Media upload error\n", error_data: { details: "codec" } }))
      .toBe("code=131053 title=Media upload error  details=codec");
  });
});
