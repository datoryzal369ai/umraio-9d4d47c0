import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { signMetaPayload } from "../src/lib/whatsapp-signature";
import {
  MAX_IMAGE_BYTES,
  buildImageMessageText,
  checkImageLimits,
  imageFallbackMessageFor,
  isUnreadableDescription,
} from "../src/lib/vision/limits.core";
import {
  classifyInboundMessage,
  persistedModality,
} from "../src/lib/whatsapp/message-classification.core";

const SECRET = "test_app_secret_value";
process.env["WHATSAPP_COALESCE_WINDOW_MS"] = "0";

type Row = Record<string, unknown>;

const state = {
  messages: [] as Row[],
  aiCalls: 0,
  outboundBodies: [] as string[],
  mediaFetches: 0,
  visionCalls: 0,
  asrCalls: 0,
  usage: [] as Row[],
  quotaAllowed: true,
  media: { ok: true, bytes: 120_000, mime: "image/jpeg" } as {
    ok: boolean;
    bytes: number;
    mime: string;
    reason?: string;
  },
  vision: { ok: true, text: "Resit pembayaran RM1,200 bertarikh 12/03/2026." } as {
    ok: boolean;
    text?: string;
    code?: string;
  },
};

vi.mock("@/integrations/supabase/client.server", () => {
  const table = (name: string) => {
    const filters: Row = {};
    const chain: Record<string, unknown> = {};
    chain["select"] = () => chain;
    chain["or"] = () => chain;
    chain["order"] = () => chain;
    chain["limit"] = () => chain;
    chain["gte"] = () => chain;
    chain["eq"] = (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    };
    chain["update"] = () => chain;
    chain["insert"] = (row: Row) => {
      if (name === "messages") {
        const pid = row["provider_message_id"];
        if (
          pid &&
          state.messages.some(
            (m) => m["agency_id"] === row["agency_id"] && m["provider_message_id"] === pid,
          )
        ) {
          return Object.assign(
            Promise.resolve({ error: { code: "23505", message: "duplicate key" } }),
            chain,
          );
        }
        if (!row["created_at"]) row["created_at"] = new Date().toISOString();
        state.messages.push(row);
      }
      return Promise.resolve({ error: null });
    };
    chain["maybeSingle"] = async () => {
      if (name === "whatsapp_configs") {
        return {
          data: { id: "cfg-1", agency_id: "agency-A", access_token: "tok", auto_reply: true },
        };
      }
      if (name === "messages") {
        const hit = state.messages.find(
          (m) =>
            m["agency_id"] === filters["agency_id"] &&
            m["provider_message_id"] === filters["provider_message_id"],
        );
        return { data: hit ? { id: "existing" } : null };
      }
      if (name === "leads") return { data: { id: "lead-1" } };
      if (name === "conversations") return { data: { id: "conv-1", ai_enabled: true } };
      return { data: null };
    };
    chain["single"] = async () => ({ data: { id: "x", ai_enabled: true } });
    chain["then"] = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => {
      let data: unknown = [];
      if (name === "messages") {
        data = state.messages.filter((m) => m["agency_id"] === filters["agency_id"]);
      }
      if (name === "conversations") data = [{ id: "conv-1" }];
      return Promise.resolve({ data, error: null }).then(ok, err);
    };
    return chain;
  };
  return { supabaseAdmin: { from: (name: string) => table(name) } };
});

vi.mock("@/lib/sales-ai.server", () => ({
  generateAgentReply: async () => {
    state.aiCalls += 1;
    return "Waalaikumsalam Tuan, saya sudah terima gambar itu.";
  },
  computeLeadScore: () => 50,
  temperatureForScore: () => "warm",
}));

vi.mock("@/lib/whatsapp/media.server", () => ({
  fetchWhatsappMedia: async () => {
    state.mediaFetches += 1;
    if (!state.media.ok) return { ok: false, reason: state.media.reason ?? "media_unavailable" };
    return {
      ok: true,
      bytes: new Uint8Array(8),
      byteLength: state.media.bytes,
      mimeType: state.media.mime,
    };
  },
}));

vi.mock("@/lib/voice/media.server", () => ({
  fetchWhatsappAudio: async () => {
    state.mediaFetches += 1;
    return { ok: true, bytes: new Uint8Array(8), byteLength: 40_000, mimeType: "audio/ogg" };
  },
}));

vi.mock("@/lib/voice/asr.server", () => ({
  ASR_MODEL: "openai/gpt-4o-transcribe",
  transcribeAudio: async () => {
    state.asrCalls += 1;
    return { ok: true, text: "Salam, saya nak tanya pakej umrah bulan Mac", durationSeconds: 12 };
  },
}));

vi.mock("@/lib/ai/gateway.server", () => ({
  createIntelligenceGateway: () => ({
    generate: async () => {
      state.visionCalls += 1;
      if (!state.vision.ok) {
        return {
          ok: false,
          data: null,
          usage: null,
          error: { code: state.vision.code ?? "unavailable", message: "x" },
        };
      }
      return { ok: true, data: state.vision.text, usage: null };
    },
  }),
}));

vi.mock("@/lib/billing/usage.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class QuotaErrorMock extends Error {
    kind: string;
    constructor(kind: string) {
      super(kind);
      this.kind = kind;
    }
  }
  return {
    ...actual,
    QuotaError: QuotaErrorMock,
    assertQuota: async () => {
      if (!state.quotaAllowed) throw new QuotaErrorMock("exceeded");
      return { allowed: true, remaining: 100 };
    },
    assertVoiceQuota: async () => ({ allowed: true, remaining: 100 }),
    recordUsageEvent: async (_db: unknown, event: Row) => {
      state.usage.push(event);
    },
  };
});

async function postWebhook(body: string, signature: string | null) {
  const { Route } = await import("../src/routes/api/public/whatsapp");
  const handler = (
    Route.options as unknown as {
      server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } };
    }
  ).server.handlers.POST;
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("x-hub-signature-256", signature);
  return handler({
    request: new Request("https://umraio.com/api/public/whatsapp", {
      method: "POST",
      headers,
      body,
    }),
  });
}

function envelope(message: Row, contact: Row = { profile: { name: "Ali" }, wa_id: "60123456789" }) {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1234567890" },
              contacts: [contact],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
}

const imageMsg = (id: string, extra: Row = {}) => ({
  id,
  from: "60123456789",
  type: "image",
  image: { id: "img-1", mime_type: "image/jpeg", ...extra },
});
const textMsg = (id: string) => ({
  id,
  from: "60123456789",
  type: "text",
  text: { body: "Salam, nak tanya pakej umrah" },
});
const audioMsg = (id: string) => ({
  id,
  from: "60123456789",
  type: "audio",
  audio: { id: "media-1", mime_type: "audio/ogg; codecs=opus", voice: true },
});

async function send(message: Row, contact?: Row) {
  const body = contact ? envelope(message, contact) : envelope(message);
  return postWebhook(body, signMetaPayload(body, SECRET));
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.messages = [];
  state.aiCalls = 0;
  state.outboundBodies = [];
  state.mediaFetches = 0;
  state.visionCalls = 0;
  state.asrCalls = 0;
  state.usage = [];
  state.quotaAllowed = true;
  state.media = { ok: true, bytes: 120_000, mime: "image/jpeg" };
  state.vision = { ok: true, text: "Resit pembayaran RM1,200 bertarikh 12/03/2026." };
  process.env["META_APP_SECRET"] = SECRET;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/messages")) {
      const parsed = JSON.parse(String((init as RequestInit).body)) as { text?: { body?: string } };
      state.outboundBodies.push(parsed.text?.body ?? "");
    }
    return new Response("{}", { status: 200 });
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("IMAGE V1 — classification and limits", () => {
  it("classifies an inbound image with media id and caption", () => {
    const c = classifyInboundMessage(imageMsg("wamid.I0", { caption: "Ini resit saya" }));
    expect(c.modality).toBe("image");
    expect(c.mediaId).toBe("img-1");
    expect(c.caption).toBe("Ini resit saya");
    expect(c.processable).toBe(true);
    expect(persistedModality(c.modality)).toBe("image");
  });

  it("F. sender resolution still works for `from` and the LID `wa_id` fallback", () => {
    const direct = classifyInboundMessage(imageMsg("wamid.I1"));
    expect(direct.senderSource).toBe("from");
    expect(direct.from).toBe("60123456789");

    const lid = classifyInboundMessage(
      { id: "wamid.I2", type: "image", image: { id: "img-9" } },
      { contactWaId: "60176927864" },
    );
    expect(lid.senderSource).toBe("wa_id");
    expect(lid.from).toBe("60176927864");
    expect(lid.processable).toBe(true);
  });

  it("enforces size and type limits", () => {
    expect(checkImageLimits({ bytes: 120_000, mimeType: "image/jpeg" })).toEqual({ ok: true });
    expect(checkImageLimits({ bytes: MAX_IMAGE_BYTES + 1, mimeType: "image/jpeg" })).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(checkImageLimits({ bytes: 0, mimeType: "image/jpeg" })).toEqual({
      ok: false,
      reason: "empty_image",
    });
    expect(checkImageLimits({ bytes: 1000, mimeType: "image/tiff" })).toEqual({
      ok: false,
      reason: "unsupported_media",
    });
  });

  it("never leaks internals in fallbacks and never fabricates contents", () => {
    for (const reason of [
      "vision_failed",
      "media_unavailable",
      "too_large",
      "unsupported_media",
      "quota_exceeded",
    ] as const) {
      const msg = imageFallbackMessageFor(reason);
      expect(msg).toMatch(/Maaf/);
      expect(msg).not.toMatch(/openai|token|status|error|gpt|gateway/i);
    }
    expect(isUnreadableDescription("UNREADABLE")).toBe(true);
    expect(isUnreadableDescription("Resit pembayaran")).toBe(false);
    const text = buildImageMessageText({ description: "Resit  RM1,200", caption: "ini resit" });
    expect(text).toContain("[Gambar daripada pelanggan] Resit RM1,200");
    expect(text).toContain("[Kapsyen pelanggan] ini resit");
  });
});

describe("IMAGE V1 — webhook pipeline", () => {
  it("C. a valid image reaches vision, persists and produces a text reply", async () => {
    const res = await send(imageMsg("wamid.IM1", { caption: "Ini resit saya" }));
    expect(res.status).toBe(200);
    expect(state.mediaFetches).toBe(1);
    expect(state.visionCalls).toBe(1);
    const inbound = state.messages.find((m) => m["sender"] === "customer");
    expect(inbound?.["modality"]).toBe("image");
    expect(inbound?.["media_id"]).toBe("img-1");
    expect(String(inbound?.["body"])).toContain("Resit pembayaran RM1,200");
    expect(state.aiCalls).toBe(1);
    expect(state.outboundBodies.length).toBe(1);
    expect(state.messages.find((m) => m["sender"] === "ai")?.["modality"]).toBe("text");
    expect(state.usage.some((u) => u["category"] === "ai_task" && u["success"])).toBe(true);
  });

  it("D. an unreadable image degrades gracefully with no fabricated content", async () => {
    state.vision = { ok: true, text: "UNREADABLE" };
    await send(imageMsg("wamid.IM2"));
    expect(state.aiCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
    expect(state.messages.some((m) => m["sender"] === "customer")).toBe(false);
    expect(state.usage.some((u) => u["success"] === false)).toBe(true);
  });

  it("D2. media retrieval failure never reaches vision", async () => {
    state.media = { ok: false, bytes: 0, mime: "image/jpeg", reason: "media_unavailable" };
    await send(imageMsg("wamid.IM3"));
    expect(state.visionCalls).toBe(0);
    expect(state.aiCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
  });

  it("D3. unsupported image type is refused before vision", async () => {
    state.media = { ok: true, bytes: 1000, mime: "image/tiff" };
    await send(imageMsg("wamid.IM4"));
    expect(state.visionCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
  });

  it("D4. exhausted quota blocks media download and vision", async () => {
    state.quotaAllowed = false;
    await send(imageMsg("wamid.IM5"));
    expect(state.mediaFetches).toBe(0);
    expect(state.visionCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
  });

  it("E. a replayed image webhook does no media fetch, no vision, no LLM", async () => {
    await send(imageMsg("wamid.IM6"));
    const before = {
      media: state.mediaFetches,
      vision: state.visionCalls,
      ai: state.aiCalls,
      out: state.outboundBodies.length,
    };
    await send(imageMsg("wamid.IM6"));
    await send(imageMsg("wamid.IM6"));
    expect(state.mediaFetches).toBe(before.media);
    expect(state.visionCalls).toBe(before.vision);
    expect(state.aiCalls).toBe(before.ai);
    expect(state.outboundBodies.length).toBe(before.out);
  });

  it("A. existing text inbound is unchanged", async () => {
    await send(textMsg("wamid.T1"));
    expect(state.visionCalls).toBe(0);
    const inbound = state.messages.find((m) => m["sender"] === "customer");
    expect(inbound?.["modality"]).toBe("text");
    expect(inbound?.["body"]).toBe("Salam, nak tanya pakej umrah");
    expect(state.aiCalls).toBe(1);
  });

  it("B. existing voice inbound is unchanged", async () => {
    await send(audioMsg("wamid.A1"));
    expect(state.visionCalls).toBe(0);
    expect(state.asrCalls).toBe(1);
    const inbound = state.messages.find((m) => m["sender"] === "customer");
    expect(inbound?.["modality"]).toBe("audio");
    expect(inbound?.["body"]).toBe("Salam, saya nak tanya pakej umrah bulan Mac");
    expect(state.aiCalls).toBe(1);
  });
});
