import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_OUTBOUND_AUDIO_BYTES,
  decideVoiceReply,
  isDeliverableAudio,
  toSpeakableText,
} from "../src/lib/voice/tts.core";
import {
  lovableVoiceEngine,
  selectVoiceEngine,
  synthesizeSpeech,
  xiaozhiVoiceEngine,
} from "../src/lib/voice/tts.server";
import { sendWhatsappAudio } from "../src/lib/whatsapp-send.server";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("voice reply decision (pure)", () => {
  it("speaks only on a voice turn", () => {
    expect(decideVoiceReply({ inboundModality: "text", replyText: "Hai" }).speak).toBe(false);
    expect(decideVoiceReply({ inboundModality: "image", replyText: "Hai" }).speak).toBe(false);
    expect(decideVoiceReply({ inboundModality: "audio", replyText: "Hai Tuan" }).speak).toBe(true);
  });

  it("falls back to text for empty or very long replies", () => {
    expect(decideVoiceReply({ inboundModality: "audio", replyText: "   " })).toEqual({
      speak: false,
      reason: "empty_reply",
    });
    expect(
      decideVoiceReply({ inboundModality: "audio", replyText: "a".repeat(1200) }),
    ).toEqual({ speak: false, reason: "too_long" });
  });

  it("strips markdown, links and emoji before speaking", () => {
    const spoken = toSpeakableText("**Pakej** Umrah 🕋 https://umraio.com\n- Disember");
    expect(spoken).not.toContain("*");
    expect(spoken).not.toContain("http");
    expect(spoken).not.toContain("🕋");
    expect(spoken).toContain("Pakej Umrah");
    expect(spoken).toContain("Disember");
  });

  it("enforces outbound audio size limits", () => {
    expect(isDeliverableAudio({ byteLength: 0 })).toBe(false);
    expect(isDeliverableAudio({ byteLength: 120_000 })).toBe(true);
    expect(isDeliverableAudio({ byteLength: MAX_OUTBOUND_AUDIO_BYTES + 1 })).toBe(false);
  });
});

describe("voice engine selection (engine-agnostic)", () => {
  it("defaults to the Lovable driver and can select XiaoZhi when configured", () => {
    expect(selectVoiceEngine().name).toBe("lovable");
    expect(selectVoiceEngine("xiaozhi").name).toBe("xiaozhi");
  });

  it("XiaoZhi driver fails cleanly until credentials exist", async () => {
    const result = await xiaozhiVoiceEngine.synthesize({ text: "Salam" });
    expect(result).toEqual({ ok: false, kind: "unsupported_engine", engine: "xiaozhi" });
  });
});

describe("TTS synthesis", () => {
  it("returns OGG audio on success", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await synthesizeSpeech({ text: "Salam Tuan", engine: lovableVoiceEngine });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe("audio/ogg");
      expect(result.bytes.byteLength).toBe(4);
    }
  });

  it("maps provider failures to typed kinds without leaking details", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    for (const [status, kind] of [
      [400, "invalid_request"],
      [401, "config"],
      [402, "entitlement"],
      [429, "rate_limited"],
      [500, "provider"],
    ] as const) {
      globalThis.fetch = vi.fn(async () => new Response("boom", { status })) as unknown as typeof fetch;
      const result = await synthesizeSpeech({ text: "Salam", engine: lovableVoiceEngine });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe(kind);
    }
  });

  it("treats empty audio as a failure", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array(0), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await synthesizeSpeech({ text: "Salam", engine: lovableVoiceEngine });
    expect(result.ok).toBe(false);
  });
});

describe("WhatsApp outbound voice", () => {
  it("uploads then sends the audio message", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/media")) return new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await sendWhatsappAudio("pn-1", "tok", "60123", {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
    });
    expect(ok).toBe(true);
    expect(calls[0]).toContain("/pn-1/media");
    expect(calls[1]).toContain("/pn-1/messages");
  });

  it("returns false when the upload fails (text answer already delivered)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    expect(
      await sendWhatsappAudio("pn-1", "tok", "60123", {
        bytes: new Uint8Array([1]),
        mimeType: "audio/ogg",
      }),
    ).toBe(false);
  });

  it("returns false when Meta returns no media id", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(
      await sendWhatsappAudio("pn-1", "tok", "60123", {
        bytes: new Uint8Array([1]),
        mimeType: "audio/ogg",
      }),
    ).toBe(false);
  });
});

describe("voice context continuity", () => {
  it("resolves a spoken affirmative against the previous UMRAIO question and keeps prior context", async () => {
    const { readContinuity, continuityInstruction, inferModalityFromBody } = await import(
      "../src/lib/sales/context-continuity.core"
    );
    const turns = [
      { sender: "customer", body: "Saya nak pakej Umrah untuk keluarga" },
      { sender: "ai", body: "[Gambar daripada pelanggan] poster pakej" },
      { sender: "ai", body: "Tuan nak saya semak pakej keluarga bulan Disember?" },
    ];
    for (const spoken of ["Ya", "Betul", "Okay", "Baik", "Ya, boleh"]) {
      const read = readContinuity({
        turns,
        latestCustomerMessage: spoken,
        modality: "audio",
      });
      expect(read.affirmativeResolved).toBe(true);
      expect(read.intentStatus).toBe("resolved");
      expect(read.pendingQuestion).toContain("Disember");
      expect(continuityInstruction(read)).toContain("AFFIRMATIVE BINDING");
    }
    expect(inferModalityFromBody("[Gambar daripada pelanggan] poster")).toBe("image");
  });

  it("keeps a consequential voice turn behind one explicit confirmation", async () => {
    const { readContinuity } = await import("../src/lib/sales/context-continuity.core");
    const read = readContinuity({
      turns: [{ sender: "ai", body: "Tuan nak saya teruskan bayaran deposit?" }],
      latestCustomerMessage: "Ya, buat deposit",
      modality: "audio",
    });
    expect(read.requiresConfirmation).toBe(true);
  });

  it("pads a fast voice reply into a natural window without long silence", async () => {
    const { presentationDelayMs, latencyBucket } = await import(
      "../src/lib/sales/context-continuity.core"
    );
    expect(latencyBucket({ modality: "audio", replyLength: 120 })).toBe("considered");
    const pad = presentationDelayMs({ elapsedMs: 400, modality: "audio", replyLength: 120 });
    expect(pad).toBeGreaterThan(0);
    expect(pad).toBeLessThanOrEqual(1_500);
    expect(presentationDelayMs({ elapsedMs: 6_000, modality: "audio", replyLength: 120 })).toBe(0);
  });
});
