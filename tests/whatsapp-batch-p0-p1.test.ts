import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signMetaPayload } from "../src/lib/whatsapp-signature";

const SECRET = "test_app_secret_value";

type Row = Record<string, unknown>;

const db = {
  configError: null as { message: string } | null,
  config: {
    id: "cfg-1",
    agency_id: "agency-1",
    access_token: "token",
    auto_reply: false,
  } as Row | null,
  leadSelects: [] as Array<Row | null>,
  conversationSelects: [] as Array<Row | null>,
  leadInsertConflict: false,
  conversationInsertConflict: false,
  inserts: [] as Array<{ table: string; row: Row }>,
};

function nextSelect(queue: Array<Row | null>): Row | null {
  return queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null);
}

function selectResult(table: string): { data: Row | null; error: unknown } {
  if (table === "whatsapp_configs") {
    return { data: db.configError ? null : db.config, error: db.configError };
  }
  if (table === "leads") return { data: nextSelect(db.leadSelects), error: null };
  if (table === "conversations") return { data: nextSelect(db.conversationSelects), error: null };
  return { data: null, error: null };
}

function insertResult(table: string): { data: Row | null; error: unknown } {
  if (table === "leads" && db.leadInsertConflict) {
    return { data: null, error: { code: "23505", message: "duplicate key" } };
  }
  if (table === "conversations" && db.conversationInsertConflict) {
    return { data: null, error: { code: "23505", message: "duplicate key" } };
  }
  if (table === "conversations") {
    return { data: { id: "conv-new", ai_enabled: true }, error: null };
  }
  if (table === "leads") return { data: { id: "lead-new" }, error: null };
  return { data: { id: `${table}-new` }, error: null };
}

function builder(table: string) {
  let op: "select" | "insert" | "update" = "select";
  const chain: Record<string, unknown> = {};
  const passthrough = ["select", "eq", "gte", "order", "limit", "is", "not"];
  for (const key of passthrough) chain[key] = () => chain;
  chain["insert"] = (row: Row) => {
    op = "insert";
    db.inserts.push({ table, row });
    return chain;
  };
  chain["update"] = () => {
    op = "update";
    return chain;
  };
  chain["maybeSingle"] = async () => (op === "insert" ? insertResult(table) : selectResult(table));
  chain["single"] = async () => (op === "insert" ? insertResult(table) : selectResult(table));
  chain["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(op === "insert" ? { error: insertResult(table).error } : { data: null, error: null }).then(
      resolve,
      reject,
    );
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => builder(table) },
}));

vi.mock("@/lib/whatsapp/coalescing.server", () => ({
  markConversationMuted: async () => undefined,
  claimConversationReply: async () => false,
  releaseConversationClaim: async () => undefined,
  loadPendingInbound: async () => [],
  waitForCoalesceWindow: async () => undefined,
  coalesceWindowMs: () => 0,
}));

vi.mock("@/lib/conversion/producers", () => ({ recordLeadCreated: async () => undefined }));

vi.mock("@/lib/sales-ai.server", () => ({
  computeLeadScore: () => 50,
  temperatureForScore: () => "warm",
  generateAgentReply: async () => null,
  prefetchReplyInputs: async () => null,
}));

function textMessage(i: number) {
  return {
    id: `wamid.${i}`,
    from: "60123456789",
    type: "text",
    text: { body: `hello ${i}` },
  };
}

function payloadWith(messages: unknown[]) {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1234567890" },
              contacts: [{ profile: { name: "Ali" }, wa_id: "60123456789" }],
              messages,
            },
          },
        ],
      },
    ],
  });
}

async function postWebhook(body: string) {
  const { Route } = await import("../src/routes/api/public/whatsapp");
  const handler = (
    Route.options as unknown as {
      server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } };
    }
  ).server.handlers.POST;
  return handler({
    request: new Request("https://umraio.com/api/public/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signMetaPayload(body, SECRET),
      },
      body,
    }),
  });
}

beforeEach(() => {
  process.env["META_APP_SECRET"] = SECRET;
  db.configError = null;
  db.config = { id: "cfg-1", agency_id: "agency-1", access_token: "token", auto_reply: false };
  db.leadSelects = [{ id: "lead-1" }];
  db.conversationSelects = [{ id: "conv-1", ai_enabled: true, conversation_state: "ACTIVE" }];
  db.leadInsertConflict = false;
  db.conversationInsertConflict = false;
  db.inserts = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const customerMessages = () =>
  db.inserts.filter((i) => i.table === "messages" && i.row["sender"] === "customer");

describe("P0-1 — every message in a webhook delivery is processed", () => {
  it("persists all messages from a multi-message delivery", async () => {
    const res = await postWebhook(payloadWith([textMessage(1), textMessage(2), textMessage(3)]));
    expect(res.status).toBe(200);
    expect(customerMessages().map((m) => m.row["provider_message_id"])).toEqual([
      "wamid.1",
      "wamid.2",
      "wamid.3",
    ]);
  });

  it("processes messages spread across multiple entries and changes", async () => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1234567890" },
                contacts: [{ wa_id: "60123456789" }],
                messages: [textMessage(1)],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1234567890" },
                contacts: [{ wa_id: "60123456789" }],
                messages: [textMessage(2)],
              },
            },
          ],
        },
      ],
    });
    await postWebhook(body);
    expect(customerMessages()).toHaveLength(2);
  });

  it("caps a single delivery at 10 messages", async () => {
    const many = Array.from({ length: 14 }, (_, i) => textMessage(i + 1));
    const res = await postWebhook(payloadWith(many));
    expect(res.status).toBe(200);
    expect(customerMessages()).toHaveLength(10);
  });
});

describe("P1-1 — unexpected config database errors are retryable", () => {
  it("returns 500 without leaking internal detail", async () => {
    db.configError = { message: "connection reset by peer" };
    const res = await postWebhook(payloadWith([textMessage(1)]));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("connection reset");
  });

  it("a missing WhatsApp configuration is still a 200 no-op", async () => {
    db.config = null;
    const res = await postWebhook(payloadWith([textMessage(1)]));
    expect(res.status).toBe(200);
    expect(customerMessages()).toHaveLength(0);
  });
});

describe("P0-2 — concurrent duplicate creation resolves to one record", () => {
  it("re-selects the winning lead and conversation on a unique violation", async () => {
    db.leadSelects = [null, { id: "lead-race" }];
    db.leadInsertConflict = true;
    db.conversationSelects = [null, { id: "conv-race", ai_enabled: true }];
    db.conversationInsertConflict = true;

    const res = await postWebhook(payloadWith([textMessage(1)]));
    expect(res.status).toBe(200);
    expect(db.inserts.filter((i) => i.table === "leads")).toHaveLength(1);
    expect(db.inserts.filter((i) => i.table === "conversations")).toHaveLength(1);
    expect(customerMessages()[0]?.row["conversation_id"]).toBe("conv-race");
  });
});

describe("P1-5 — unsupported/document inbound is persisted", () => {
  it("persists a document turn without inventing text", async () => {
    const res = await postWebhook(
      payloadWith([
        {
          id: "wamid.doc",
          from: "60123456789",
          type: "document",
          document: { id: "media-1", filename: "itinerary.pdf", mime_type: "application/pdf" },
        },
      ]),
    );
    expect(res.status).toBe(200);
    const persisted = customerMessages();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.row["provider_message_id"]).toBe("wamid.doc");
    expect(persisted[0]?.row["body"]).toBe("");
    expect(persisted[0]?.row["media_id"]).toBe("media-1");
  });

  it("persists an unsupported modality turn", async () => {
    await postWebhook(
      payloadWith([{ id: "wamid.sticker", from: "60123456789", type: "sticker" }]),
    );
    expect(customerMessages()).toHaveLength(1);
  });
});
