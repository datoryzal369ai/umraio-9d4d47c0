import { beforeEach, describe, expect, it } from "vitest";

import {
  PUBLIC_QUOTATION_INVALID_MESSAGE,
  PUBLIC_QUOTATION_LIMITS,
  checkPublicQuotationRate,
  resetPublicQuotationRateLimit,
} from "@/lib/quotations/public-rate-limit.core";
import {
  readQuotationByToken,
  respondToQuotationByToken,
  toPublicQuotation,
} from "@/lib/quotations/quotations.server";
import { canTransition } from "@/lib/quotations/pricing.core";

const ROW = {
  id: "q-1",
  agency_id: "a-1",
  lead_id: "l-1",
  conversation_id: "c-1",
  package_id: "p-1",
  created_by: "u-1",
  public_token: "abcdef0123456789",
  notes: "internal margin note",
  quotation_number: "Q-001",
  status: "ready",
  currency: "MYR",
  customer_name: "Ali",
  travel_date: null,
  travel_month: "Ramadan",
  number_of_pilgrims: 2,
  unit_price: 1000,
  quantity: 2,
  subtotal: 2000,
  discount: 0,
  total: 2000,
  deposit_amount: 500,
  balance_amount: 1500,
  valid_until: new Date(Date.now() + 86_400_000).toISOString(),
  package_snapshot: {
    name: "Umrah 12D",
    hotel_makkah: "Hilton",
    nights: 12,
    inclusions: ["Visa"],
    internal_cost_myr: 700,
    supplier_id: "s-9",
  },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeDb(row: any) {
  const updates: any[] = [];
  const db: any = {
    from(table: string) {
      const builder: any = {
        _table: table,
        select() {
          return builder;
        },
        update(patch: any) {
          updates.push({ table, patch });
          return builder;
        },
        insert() {
          return Promise.resolve({ data: null, error: null });
        },
        eq() {
          return builder;
        },
        maybeSingle() {
          if (table === "quotations") return Promise.resolve({ data: row, error: null });
          return Promise.resolve({ data: { name: "Agency" }, error: null });
        },
        then(resolve: any) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { db, updates };
}

describe("public quotation projection", () => {
  it("returns a valid quotation with customer-facing fields", async () => {
    const { db } = fakeDb({ ...ROW });
    const result = await readQuotationByToken(db, ROW.public_token);
    expect(result?.quotation.quotation_number).toBe("Q-001");
    expect(result?.quotation.total).toBe(2000);
    expect(result?.quotation.deposit_amount).toBe(500);
    expect(result?.quotation.package_snapshot["name"]).toBe("Umrah 12D");
  });

  it("never exposes internal identifiers or notes", () => {
    const pub = toPublicQuotation({ ...ROW }) as Record<string, unknown>;
    for (const forbidden of [
      "id",
      "agency_id",
      "lead_id",
      "conversation_id",
      "package_id",
      "created_by",
      "public_token",
      "notes",
    ]) {
      expect(pub[forbidden]).toBeUndefined();
    }
    const snap = pub["package_snapshot"] as Record<string, unknown>;
    expect(snap["internal_cost_myr"]).toBeUndefined();
    expect(snap["supplier_id"]).toBeUndefined();
  });

  it("returns null for an unknown token", async () => {
    const { db } = fakeDb(null);
    expect(await readQuotationByToken(db, "0000000000000000")).toBeNull();
  });

  it("marks an out-of-date quotation expired without leaking internals", async () => {
    const { db } = fakeDb({
      ...ROW,
      valid_until: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const result = await readQuotationByToken(db, ROW.public_token);
    expect(result?.quotation.status).toBe("expired");
    expect((result?.quotation as Record<string, unknown>)["agency_id"]).toBeUndefined();
  });
});

describe("generic invalid/expired response", () => {
  it("uses one generic message for unknown tokens", async () => {
    const { db } = fakeDb(null);
    await expect(respondToQuotationByToken(db, "0000000000000000", "accepted")).rejects.toThrow(
      PUBLIC_QUOTATION_INVALID_MESSAGE,
    );
  });

  it("uses the same message for terminal quotations", async () => {
    const { db } = fakeDb({ ...ROW, status: "cancelled" });
    await expect(
      respondToQuotationByToken(db, ROW.public_token, "accepted"),
    ).rejects.toThrow(PUBLIC_QUOTATION_INVALID_MESSAGE);
  });

  it("leaves the state machine unchanged", () => {
    expect(canTransition("ready", "accepted")).toBe(true);
    expect(canTransition("cancelled", "accepted")).toBe(false);
    expect(canTransition("sent", "viewed")).toBe(true);
  });
});

describe("hashed-IP rate limits", () => {
  beforeEach(() => resetPublicQuotationRateLimit());

  it("allows 60 reads per IP per hour", () => {
    const hash = "hash-read";
    for (let i = 0; i < PUBLIC_QUOTATION_LIMITS.read; i += 1) {
      expect(checkPublicQuotationRate("read", hash).allowed).toBe(true);
    }
    expect(checkPublicQuotationRate("read", hash).allowed).toBe(false);
  });

  it("allows 10 responses per IP per hour", () => {
    const hash = "hash-respond";
    for (let i = 0; i < PUBLIC_QUOTATION_LIMITS.respond; i += 1) {
      expect(checkPublicQuotationRate("respond", hash).allowed).toBe(true);
    }
    expect(checkPublicQuotationRate("respond", hash).allowed).toBe(false);
  });

  it("isolates counters per IP hash and per action", () => {
    for (let i = 0; i < PUBLIC_QUOTATION_LIMITS.respond; i += 1) {
      checkPublicQuotationRate("respond", "ip-a");
    }
    expect(checkPublicQuotationRate("respond", "ip-a").allowed).toBe(false);
    expect(checkPublicQuotationRate("respond", "ip-b").allowed).toBe(true);
    expect(checkPublicQuotationRate("read", "ip-a").allowed).toBe(true);
  });

  it("expires the window after an hour", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < PUBLIC_QUOTATION_LIMITS.respond; i += 1) {
      checkPublicQuotationRate("respond", "ip-window", t0);
    }
    expect(checkPublicQuotationRate("respond", "ip-window", t0).allowed).toBe(false);
    expect(
      checkPublicQuotationRate("respond", "ip-window", t0 + 60 * 60_000 + 1).allowed,
    ).toBe(true);
  });

  it("never stores a raw IP address", async () => {
    const { clientIpHash } = await import("@/lib/billing/demo-limit.server");
    const hash = clientIpHash(
      new Request("https://x.test", { headers: { "x-forwarded-for": "203.0.113.9" } }),
    );
    expect(hash).not.toContain("203.0.113.9");
    expect(hash).toMatch(/^[a-f0-9]{48}$/);
    checkPublicQuotationRate("read", hash);
  });

  it("fails open when the hash is unavailable", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(checkPublicQuotationRate("read", "").allowed).toBe(true);
    }
  });
});
