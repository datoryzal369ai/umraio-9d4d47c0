import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { signMetaPayload } from "../src/lib/whatsapp-signature";
import {
  MAX_VOICE_BYTES,
  checkAudioLimits,
  estimateDurationSeconds,
  fallbackMessageFor,
  normalizeTranscript,
} from "../src/lib/voice/limits.core";
import {
  AUDIO_COALESCE_WINDOW_MS,
  COALESCE_WINDOW_MS,
} from "../src/lib/whatsapp/coalescing.core";

const SECRET = "test_app_secret_value";
process.env["WHATSAPP_COALESCE_WINDOW_MS"] = "0";

type Row = Record<string, unknown>;

const state = {
  messages: [] as Row[],
  aiCalls: 0,
  outboundBodies: [] as string[],
  mediaFetches: 0,
  asrCalls: 0,
  usage: [] as Row[],
  reviews: [] as Row[],
  ttsCalls: 0,
  audioSends: 0,
  quotaAllowed: true,
  media: { ok: true, bytes: 40_000 } as { ok: boolean; bytes: number; reason?: string },
  asr: { ok: true, text: "Salam, saya nak tanya pakej umrah bulan Mac" } as {
    ok: boolean;
    text?: string;
    kind?: string;
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
    chain["in"] = () => chain;
    chain["is"] = () => chain;
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
      if (name === "islamic_reviews") {
        const review = [...state.reviews].reverse().find((row) =>
          row["conversation_id"] === filters["conversation_id"]
        );
        return { data: review ?? null };
      }
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
    if (state.asr.text?.includes("fatwa")) {
      state.reviews.push({
        id: `review-${state.reviews.length + 1}`,
        conversation_id: "conv-1",
        question: state.asr.text,
        status: "PENDING",
        holding_sent_at: null,
        created_at: new Date(Date.now() + 10).toISOString(),
      });
      return "Baik Datuk, soalan itu saya dah terima. Saya sedang dapatkan semakan daripada pembimbing agama.";
    }
    return "Waalaikumsalam Tuan, boleh saya bantu?";
  },
  computeLeadScore: () => 50,
  temperatureForScore: () => "warm",
}));

vi.mock("@/lib/voice/media.server", () => ({
  fetchWhatsappAudio: async () => {
    state.mediaFetches += 1;
    if (!state.media.ok) return { ok: false, reason: state.media.reason ?? "media_unavailable" };
    return {
      ok: true,
      bytes: new Uint8Array(8),
      byteLength: state.media.bytes,
      mimeType: "audio/ogg",
    };
  },
}));

vi.mock("@/lib/voice/asr.server", () => ({
  ASR_MODEL: "openai/gpt-4o-transcribe",
  transcribeAudio: async () => {
    state.asrCalls += 1;
    if (!state.asr.ok) return { ok: false, kind: state.asr.kind ?? "provider", status: 500 };
    return { ok: true, text: state.asr.text, durationSeconds: 12 };
  },
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
    assertVoiceQuota: async () => {
      if (!state.quotaAllowed) throw new QuotaErrorMock("exceeded");
      return { allowed: true, remaining: 100 };
    },
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

function envelope(message: Row) {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1234567890" },
              contacts: [{ profile: { name: "Ali" }, wa_id: "60123456789" }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
}

const audioMsg = (id: string, mediaId = "media-1") => ({
  id,
  from: "60123456789",
  type: "audio",
  audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true },
});
const textMsg = (id: string) => ({
  id,
  from: "60123456789",
  type: "text",
  text: { body: "Salam, nak tanya pakej umrah" },
});

async function send(message: Row) {
  const body = envelope(message);
  return postWebhook(body, signMetaPayload(body, SECRET));
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.messages = [];
  state.aiCalls = 0;
  state.outboundBodies = [];
  state.mediaFetches = 0;
  state.asrCalls = 0;
  state.usage = [];
  state.reviews = [];
  state.ttsCalls = 0;
  state.audioSends = 0;
  state.quotaAllowed = true;
  state.media = { ok: true, bytes: 40_000 };
  state.asr = { ok: true, text: "Salam, saya nak tanya pakej umrah bulan Mac" };
  process.env["META_APP_SECRET"] = SECRET;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/audio/speech")) {
      state.ttsCalls += 1;
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    if (url.endsWith("/media")) {
      return new Response(JSON.stringify({ id: "outbound-media-1" }), { status: 200 });
    }
    if (url.includes("/messages")) {
      const parsed = JSON.parse(String((init as RequestInit).body)) as {
        text?: { body?: string };
        type?: string;
      };
      // Typing indicators post to the same endpoint with no text body.
      if (parsed.text?.body) state.outboundBodies.push(parsed.text.body);
      if (parsed.type === "audio") state.audioSends += 1;
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

describe("VOICE V1 — limits and normalization", () => {
  it("accepts a normal voice note", () => {
    expect(checkAudioLimits({ bytes: 40_000 })).toEqual({ ok: true, durationSeconds: 20 });
  });

  it("rejects oversized audio", () => {
    expect(checkAudioLimits({ bytes: MAX_VOICE_BYTES + 1 })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("rejects audio longer than 30 seconds", () => {
    expect(checkAudioLimits({ bytes: 1_000, durationSeconds: 45 })).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(estimateDurationSeconds(80_000)).toBe(40);
    expect(checkAudioLimits({ bytes: 80_000 }).ok).toBe(false);
  });

  it("rejects empty audio", () => {
    expect(checkAudioLimits({ bytes: 0 })).toEqual({ ok: false, reason: "empty_audio" });
  });

  it("normalizes whitespace only, preserving names, numbers and code switching", () => {
    const raw = "  Salam,  saya   Dato' Ryzal.  Nak  book 4 pax,   RM12,500  bulan  March ok? ";
    expect(normalizeTranscript(raw)).toBe(
      "Salam, saya Dato' Ryzal. Nak book 4 pax, RM12,500 bulan March ok?",
    );
  });

  it("never exposes internal errors in the customer fallback", () => {
    for (const reason of ["asr_failed", "media_unavailable", "too_long", "quota_exceeded"] as const) {
      const msg = fallbackMessageFor(reason);
      expect(msg).toMatch(/Maaf/);
      expect(msg).not.toMatch(/openai|token|status|error|gpt/i);
    }
  });

  it("audio turns coalesce faster than text turns", () => {
    expect(AUDIO_COALESCE_WINDOW_MS).toBeLessThan(COALESCE_WINDOW_MS);
    expect(AUDIO_COALESCE_WINDOW_MS).toBeGreaterThanOrEqual(2_000);
    expect(AUDIO_COALESCE_WINDOW_MS).toBeLessThanOrEqual(4_000);
  });
});

describe("VOICE V1 — webhook pipeline", () => {
  it("A. valid voice note is fetched, transcribed, persisted and answered", async () => {
    const res = await send(audioMsg("wamid.V1", "media-abc"));
    expect(res.status).toBe(200);
    expect(state.mediaFetches).toBe(1);
    expect(state.asrCalls).toBe(1);
    const inbound = state.messages.find((m) => m["sender"] === "customer");
    expect(inbound?.["modality"]).toBe("audio");
    expect(inbound?.["media_id"]).toBe("media-abc");
    expect(inbound?.["body"]).toBe("Salam, saya nak tanya pakej umrah bulan Mac");
    expect(state.aiCalls).toBe(1);
    expect(state.outboundBodies.length).toBe(1);
    const aiMsg = state.messages.find((m) => m["sender"] === "ai");
    expect(aiMsg?.["modality"]).toBe("text");
    expect(state.usage.some((u) => u["category"] === "voice_transcription" && u["success"])).toBe(
      true,
    );
    expect(state.usage[0]?.["durationSeconds"]).toBe(12);
  });

  it("B. replayed voice message does no media fetch, no ASR, no LLM, no quota", async () => {
    await send(audioMsg("wamid.V2"));
    const before = {
      media: state.mediaFetches,
      asr: state.asrCalls,
      ai: state.aiCalls,
      usage: state.usage.length,
      out: state.outboundBodies.length,
    };
    await send(audioMsg("wamid.V2"));
    await send(audioMsg("wamid.V2"));
    expect(state.mediaFetches).toBe(before.media);
    expect(state.asrCalls).toBe(before.asr);
    expect(state.aiCalls).toBe(before.ai);
    expect(state.usage.length).toBe(before.usage);
    expect(state.outboundBodies.length).toBe(before.out);
  });

  it("C. exhausted voice quota blocks ASR and media download", async () => {
    state.quotaAllowed = false;
    await send(audioMsg("wamid.V3"));
    expect(state.mediaFetches).toBe(0);
    expect(state.asrCalls).toBe(0);
    expect(state.aiCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
  });

  it("D. media retrieval failure falls back gracefully with no LLM call", async () => {
    state.media = { ok: false, bytes: 0, reason: "media_unavailable" };
    await send(audioMsg("wamid.V4"));
    expect(state.asrCalls).toBe(0);
    expect(state.aiCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
    expect(state.messages.some((m) => m["sender"] === "customer")).toBe(false);
  });

  it("E. ASR failure never fabricates an answer", async () => {
    state.asr = { ok: false, kind: "provider" };
    await send(audioMsg("wamid.V5"));
    expect(state.aiCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
    expect(state.usage.some((u) => u["success"] === false)).toBe(true);
  });

  it("G. oversized audio is rejected safely before ASR", async () => {
    state.media = { ok: true, bytes: MAX_VOICE_BYTES + 10 };
    await send(audioMsg("wamid.V6"));
    expect(state.asrCalls).toBe(0);
    expect(state.aiCalls).toBe(0);
    expect(state.outboundBodies[0]).toMatch(/Maaf/);
  });

  it("H. audio longer than 30s is rejected safely", async () => {
    state.media = { ok: true, bytes: 200_000 }; // ~100s
    await send(audioMsg("wamid.V7"));
    expect(state.asrCalls).toBe(0);
    expect(state.aiCalls).toBe(0);
  });

  it("I/J. Malay and mixed Malay-English transcripts enter the pipeline verbatim", async () => {
    state.asr = { ok: true, text: "Salam Tuan, saya nak book 4 pax untuk March intake ya" };
    await send(audioMsg("wamid.V8"));
    const inbound = state.messages.find((m) => m["sender"] === "customer");
    expect(inbound?.["body"]).toBe("Salam Tuan, saya nak book 4 pax untuk March intake ya");
    expect(state.aiCalls).toBe(1);
  });

  it("K. existing text behaviour is untouched by voice", async () => {
    await send(textMsg("wamid.T9"));
    expect(state.mediaFetches).toBe(0);
    expect(state.asrCalls).toBe(0);
    expect(state.usage.length).toBe(0);
    const inbound = state.messages.find((m) => m["sender"] === "customer");
    expect(inbound?.["modality"]).toBe("text");
    expect(state.aiCalls).toBe(1);
  });

  it("invalid HMAC still rejects voice payloads before any voice work", async () => {
    const body = envelope(audioMsg("wamid.V10"));
    const res = await postWebhook(body, `sha256=${"a".repeat(64)}`);
    expect(res.status).toBe(401);
    expect(state.mediaFetches).toBe(0);
    expect(state.asrCalls).toBe(0);
  });

  it.each([
    "Saya nak tanya pasal pakej Umrah 12 hari.",
    "Berapa harga pakej?",
    "Apa maksud Talbiyah?",
  ])(
    "V2.5.1 old PENDING review does not block current voice: %s",
    async (transcript) => {
      state.reviews.push({
        id: "review-old",
        conversation_id: "conv-1",
        question: "Boleh minta fatwa tentang keadaan khusus saya?",
        status: "PENDING",
        holding_sent_at: null,
        created_at: "2026-08-23T10:00:00.000Z",
      });
      state.asr = { ok: true, text: transcript };

      await send(audioMsg(`wamid.${transcript.length}`));

      expect(state.aiCalls).toBe(1);
      expect(state.outboundBodies).not.toContainEqual(expect.stringContaining("pembimbing agama"));
      expect(state.ttsCalls).toBe(1);
      expect(state.audioSends).toBe(1);
      expect(state.reviews).toHaveLength(1);
    },
  );

  it("V2.5.1 current HIGH_RISK voice creates review and suppresses only its audio", async () => {
    state.asr = { ok: true, text: "Boleh minta fatwa tentang keadaan khusus saya?" };

    await send(audioMsg("wamid.HIGH-RISK"));

    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]?.["question"]).toBe(state.asr.text);
    expect(state.outboundBodies).toContainEqual(expect.stringContaining("pembimbing agama"));
    expect(state.ttsCalls).toBe(0);
    expect(state.audioSends).toBe(0);
  });
});
