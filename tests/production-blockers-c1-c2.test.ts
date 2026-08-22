import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { signMetaPayload } from "../src/lib/whatsapp-signature";

const SECRET = "test_app_secret_value";
const CRON_SECRET = "test_cron_secret_value_1234567890";
process.env["WHATSAPP_COALESCE_WINDOW_MS"] = "0";

const PUBLISHABLE = "sb_publishable_jaH1v305MWLN1yWA4UBH1Q_DNl0S5YZ";

// ---------------- shared fake DB ----------------
type Row = Record<string, unknown>;
const db = {
  messages: [] as Row[],
  aiCalls: 0,
  outboundSends: 0,
};

vi.mock("@/integrations/supabase/client.server", () => {
  const table = (name: string) => {
    const filters: Row = {};
    const chain: Record<string, unknown> = {};
    chain["select"] = () =>
      Object.assign(Promise.resolve({ data: [{ id: "conv-1" }], error: null }), chain);
    chain["or"] = () => chain;
    chain["order"] = () => chain;
    chain["limit"] = () => chain;
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
          const dup = { error: { code: "23505", message: "duplicate key" } };
          return Object.assign(Promise.resolve(dup), chain);
        }
        db.messages.push(row);
      }
      return Object.assign(Promise.resolve({ error: null }), chain);
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
    return chain;
  };
  return {
    supabaseAdmin: {
      from: (name: string) => table(name),
      rpc: async (_fn: string, args: { token: string }) => ({
        data: args.token === CRON_SECRET,
        error: null,
      }),
    },
  };
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

function payload(messageId: string, phoneNumberId = "1234567890") {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Ali" }, wa_id: "60123456789" }],
              messages: [
                { id: messageId, from: "60123456789", type: "text", text: { body: "Salam" } },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function callHook(route: string, headers: Record<string, string>) {
  const mod =
    route === "task-engine"
      ? await import("../src/routes/api/public/hooks/task-engine")
      : await import("../src/routes/api/public/hooks/executive-autonomy");
  const handler = (
    mod.Route.options as unknown as {
      server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } };
    }
  ).server.handlers.POST;
  return handler({
    request: new Request(`https://umraio.com/api/public/hooks/${route}`, {
      method: "POST",
      headers: new Headers(headers),
      body: "{}",
    }),
  });
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const logged: string[] = [];

beforeEach(() => {
  db.messages = [];
  db.aiCalls = 0;
  db.outboundSends = 0;
  logged.length = 0;
  process.env["META_APP_SECRET"] = SECRET;
  process.env["CRON_SECRET"] = CRON_SECRET;
  process.env["SUPABASE_PUBLISHABLE_KEY"] = PUBLISHABLE;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).includes("graph.facebook.com")) db.outboundSends += 1;
    return new Response("{}", { status: 200 });
  });
  logSpy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));
  errSpy = vi.spyOn(console, "error").mockImplementation((...a) => logged.push(a.join(" ")));
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("C1 — autonomy hooks require server-only CRON_SECRET", () => {
  for (const route of ["task-engine", "executive-autonomy"]) {
    it(`${route}: A. no Authorization header → 401`, async () => {
      expect((await callHook(route, {})).status).toBe(401);
    });
    it(`${route}: B. wrong secret → 401`, async () => {
      expect((await callHook(route, { authorization: "Bearer nope" })).status).toBe(401);
    });
    it(`${route}: C. publishable key does not authorize → 401`, async () => {
      expect((await callHook(route, { apikey: PUBLISHABLE })).status).toBe(401);
      expect((await callHook(route, { authorization: `Bearer ${PUBLISHABLE}` })).status).toBe(401);
    });
    it(`${route}: D. correct CRON_SECRET → authorized`, async () => {
      const res = await callHook(route, { authorization: `Bearer ${CRON_SECRET}` });
      expect(res.status).not.toBe(401);
    });
  }

  it("F. the secret is never written to logs", async () => {
    await callHook("task-engine", { authorization: `Bearer ${CRON_SECRET}` });
    await callHook("task-engine", { authorization: "Bearer wrong" });
    expect(logged.join("\n")).not.toContain(CRON_SECRET);
    expect(logged.join("\n").toLowerCase()).not.toContain("bearer ");
  });

  it("E. no VITE_ exposure of the cron secret", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/cron-auth.server.ts", "utf8");
    expect(src).not.toContain("VITE_");
    expect(src).not.toContain("import.meta.env");
  });
});

describe("C2 — WhatsApp webhook idempotency", () => {
  it("A. first delivery processes once", async () => {
    const body = payload("wamid.AAA");
    const res = await postWebhook(body, signMetaPayload(body, SECRET));
    expect(res.status).toBe(200);
    expect(db.messages.filter((m) => m["sender"] === "customer")).toHaveLength(1);
    expect(db.aiCalls).toBe(1);
    expect(db.outboundSends).toBe(1);
  });

  it("B. replay of the same message id → 200, no new work", async () => {
    const body = payload("wamid.BBB");
    const sig = signMetaPayload(body, SECRET);
    await postWebhook(body, sig);
    const before = { msgs: db.messages.length, ai: db.aiCalls, sends: db.outboundSends };
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);
    expect(db.messages.length).toBe(before.msgs);
    expect(db.aiCalls).toBe(before.ai);
    expect(db.outboundSends).toBe(before.sends);
  });

  it("C. concurrent identical deliveries → exactly one processing path", async () => {
    const body = payload("wamid.CCC");
    const sig = signMetaPayload(body, SECRET);
    const [r1, r2] = await Promise.all([postWebhook(body, sig), postWebhook(body, sig)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(db.messages.filter((m) => m["provider_message_id"] === "wamid.CCC")).toHaveLength(1);
    expect(db.aiCalls).toBe(1);
    expect(db.outboundSends).toBe(1);
  });

  it("D. a different message id is processed normally", async () => {
    const b1 = payload("wamid.D1");
    const b2 = payload("wamid.D2");
    await postWebhook(b1, signMetaPayload(b1, SECRET));
    await postWebhook(b2, signMetaPayload(b2, SECRET));
    expect(db.messages.filter((m) => m["sender"] === "customer")).toHaveLength(2);
    expect(db.aiCalls).toBe(2);
  });

  it("E. the same provider id in another agency stays isolated", async () => {
    const a = payload("wamid.SHARED", "1234567890");
    const b = payload("wamid.SHARED", "999");
    await postWebhook(a, signMetaPayload(a, SECRET));
    await postWebhook(b, signMetaPayload(b, SECRET));
    const rows = db.messages.filter((m) => m["provider_message_id"] === "wamid.SHARED");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r["agency_id"]))).toEqual(new Set(["agency-A", "agency-B"]));
  });

  it("F. invalid HMAC is rejected before any DB / AI / Meta work", async () => {
    const body = payload("wamid.FFF");
    const res = await postWebhook(body, `sha256=${"a".repeat(64)}`);
    expect(res.status).toBe(401);
    expect(db.messages).toHaveLength(0);
    expect(db.aiCalls).toBe(0);
    expect(db.outboundSends).toBe(0);
  });
});
