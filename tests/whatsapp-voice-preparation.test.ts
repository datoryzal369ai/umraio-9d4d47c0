import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { signMetaPayload } from "../src/lib/whatsapp-signature";
import {
  classifyInboundMessage,
  persistedModality,
} from "../src/lib/whatsapp/message-classification.core";
import { bucketFor } from "../src/lib/billing/usage.server";
import { PLAN_ENTITLEMENTS } from "../src/lib/billing/entitlements.server";

const SECRET = "test_app_secret_value";
process.env["WHATSAPP_COALESCE_WINDOW_MS"] = "0";

type Row = Record<string, unknown>;
const db = {
  messages: [] as Row[],
  aiCalls: 0,
  outboundSends: 0,
  mediaFetches: 0,
  asrCalls: 0,
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
          db.messages.some(
            (m) => m["agency_id"] === row["agency_id"] && m["provider_message_id"] === pid,
          )
        ) {
          return Object.assign(
            Promise.resolve({ error: { code: "23505", message: "duplicate key" } }),
            chain,
          );
        }
        if (!row["created_at"]) row["created_at"] = new Date().toISOString();
        db.messages.push(row);
      }
      return Promise.resolve({ error: null });
    };
    chain["maybeSingle"] = async () => {
      if (name === "whatsapp_configs") {
        return {
          data: {
            id: "cfg-1",
            agency_id: filters["phone_number_id"] === "999" ? "agency-B" : "agency-A",
            access_token: "tok",
            auto_reply: true,
          },
        };
      }
      if (name === "messages") {
        const hit = db.messages.find(
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
        data = db.messages.filter(
          (m) =>
            m["agency_id"] === filters["agency_id"] &&
            (filters["conversation_id"] === undefined ||
              m["conversation_id"] === filters["conversation_id"]),
        );
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
    db.aiCalls += 1;
    return "reply";
  },
  computeLeadScore: () => 50,
  temperatureForScore: () => "warm",
}));

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

function envelope(message: Row, phoneNumberId = "1234567890") {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Ali" }, wa_id: "60123456789" }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
}

const textMsg = (id: string) => ({
  id,
  from: "60123456789",
  type: "text",
  text: { body: "Salam, nak tanya pakej umrah" },
});
const audioMsg = (id: string, mediaId = "media-1") => ({
  id,
  from: "60123456789",
  type: "audio",
  audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true },
});

async function send(message: Row, phoneNumberId?: string) {
  const body = envelope(message, phoneNumberId);
  return postWebhook(body, signMetaPayload(body, SECRET));
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.messages = [];
  db.aiCalls = 0;
  db.outboundSends = 0;
  db.mediaFetches = 0;
  db.asrCalls = 0;
  process.env["META_APP_SECRET"] = SECRET;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("graph.facebook.com/") && url.includes("/messages")) db.outboundSends += 1;
    else if (url.includes("graph.facebook.com")) db.mediaFetches += 1;
    if (url.includes("transcription") || url.includes("whisper") || url.includes("speech"))
      db.asrCalls += 1;
    return new Response("{}", { status: 200 });
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("PREP 3 — message classification", () => {
  it("classifies text", () => {
    const c = classifyInboundMessage(textMsg("wamid.T1"));
    expect(c.modality).toBe("text");
    expect(c.processable).toBe(true);
    expect(c.mediaId).toBeNull();
  });

  it("classifies audio and captures the Meta media id without a transcript", () => {
    const c = classifyInboundMessage(audioMsg("wamid.A1", "media-xyz"));
    expect(c.modality).toBe("audio");
    expect(c.mediaId).toBe("media-xyz");
    expect(c.text).toBe("");
    expect(c.providerMessageId).toBe("wamid.A1");
  });

  it("classifies everything else as unsupported and never processable", () => {
    for (const type of ["document", "sticker", "location", "unknown"]) {
      const c = classifyInboundMessage({ id: "x", from: "60", type });
      expect(c.modality).toBe("unsupported");
      expect(c.processable).toBe(false);
      expect(c.text).toBe("");
    }
  });

  it("persisted modality only ever yields text or audio", () => {
    expect(persistedModality("text")).toBe("text");
    expect(persistedModality("audio")).toBe("audio");
    expect(persistedModality("unsupported")).toBe("text");
  });
});

describe("PREP 1/2/3 — webhook behaviour", () => {
  it("normal text inbound is processed and stored with modality=text", async () => {
    const res = await send(textMsg("wamid.T1"));
    expect(res.status).toBe(200);
    const inbound = db.messages.find((m) => m["sender"] === "customer");
    expect(inbound?.["modality"]).toBe("text");
    expect(inbound?.["media_id"]).toBeNull();
    expect(db.aiCalls).toBe(1);
  });

  it("duplicate text inbound returns 200 with no second AI call or message", async () => {
    await send(textMsg("wamid.T2"));
    const before = { msgs: db.messages.length, ai: db.aiCalls, out: db.outboundSends };
    const res = await send(textMsg("wamid.T2"));
    expect(res.status).toBe(200);
    expect(db.messages.length).toBe(before.msgs);
    expect(db.aiCalls).toBe(before.ai);
    expect(db.outboundSends).toBe(before.out);
  });

  it("audio inbound never reaches the sales brain when transcription fails", async () => {
    // The harness returns an empty Graph payload, so media retrieval fails and
    // the customer gets an honest fallback instead of a guessed sales answer.
    const res = await send(audioMsg("wamid.A1"));
    expect(res.status).toBe(200);
    expect(db.aiCalls).toBe(0);
  });

  it("unsupported types are ignored without AI or outbound side effects", async () => {
    const res = await send({ id: "wamid.I1", from: "60123456789", type: "image" });
    expect(res.status).toBe(200);
    expect(db.aiCalls).toBe(0);
    expect(db.outboundSends).toBe(0);
    expect(db.messages.length).toBe(0);
  });

  it("invalid HMAC is still rejected for audio", async () => {
    const body = envelope(audioMsg("wamid.A3"));
    const res = await postWebhook(body, `sha256=${"a".repeat(64)}`);
    expect(res.status).toBe(401);
  });

  it("identical provider_message_id in another tenant is processed independently", async () => {
    await send(textMsg("wamid.X1"));
    await send(textMsg("wamid.X1"), "999");
    const agencies = db.messages
      .filter((m) => m["sender"] === "customer")
      .map((m) => m["agency_id"]);
    expect(agencies).toContain("agency-A");
    expect(agencies).toContain("agency-B");
  });

  it("existing stored messages remain readable regardless of modality", async () => {
    await send(textMsg("wamid.T3"));
    expect(db.messages.every((m) => typeof m["body"] === "string")).toBe(true);
  });
});

describe("PREP 4 — voice metering", () => {
  it("voice usage maps to its own quota bucket", () => {
    expect(bucketFor("voice_transcription")).toBe("voice_minutes");
    expect(bucketFor("customer_reply")).toBe("ai_replies");
    expect(bucketFor("ai_task")).toBe("ai_tasks");
    expect(bucketFor("internal_operation")).toBe("none");
  });

  it("every plan declares a voice allowance without losing existing limits", () => {
    for (const plan of Object.values(PLAN_ENTITLEMENTS)) {
      expect(typeof plan.voiceMinutesPerMonth).toBe("number");
      expect(plan.voiceMinutesPerMonth).toBeGreaterThan(0);
      expect(plan.aiRepliesPerMonth).toBeGreaterThan(0);
      expect(plan.aiTasksPerMonth).toBeGreaterThan(0);
    }
  });

  it("higher plans allow at least as many voice minutes", () => {
    expect(PLAN_ENTITLEMENTS.premium.voiceMinutesPerMonth).toBeGreaterThan(
      PLAN_ENTITLEMENTS.basic.voiceMinutesPerMonth,
    );
    expect(PLAN_ENTITLEMENTS.enterprise.voiceMinutesPerMonth).toBeGreaterThanOrEqual(
      PLAN_ENTITLEMENTS.premium.voiceMinutesPerMonth,
    );
  });

  it("a voice note that cannot be transcribed persists no customer message", async () => {
    await send(audioMsg("wamid.A9"));
    expect(db.messages.filter((m) => m["sender"] === "customer").length).toBe(0);
  });
});
