import { describe, expect, it } from "vitest";

import {
  DEVELOPER_ENV_KEYS,
  DEVELOPER_SECURITY_INDICATORS,
  DEVELOPER_TASKS,
  containsForbiddenKeys,
  describeEnvPresence,
  errorClass,
  integration,
  sanitizeErrorEntry,
} from "@/lib/developer/developer.core";

describe("developer console — environment exposure", () => {
  it("reports presence only, never values", () => {
    const entries = describeEnvPresence((name) =>
      name === "OPENAI_API_KEY" ? "sk-supersecretvalue123456" : undefined,
    );
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("supersecret");
    expect(entries.find((e) => e.name === "OPENAI_API_KEY")?.state).toBe("configured");
    expect(entries.find((e) => e.name === "CRON_SECRET")?.state).toBe("missing");
  });

  it("treats blank values as missing", () => {
    const entries = describeEnvPresence(() => "   ", ["STRIPE_SECRET_KEY"]);
    expect(entries[0]?.state).toBe("missing");
  });

  it("only ever exposes allow-listed key names", () => {
    expect(DEVELOPER_ENV_KEYS.length).toBeGreaterThan(0);
    for (const key of DEVELOPER_ENV_KEYS) expect(key).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe("developer console — error sanitization", () => {
  it("redacts PII and credentials from diagnostic messages", () => {
    const entry = sanitizeErrorEntry({
      id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-09-01T00:00:00.000Z",
      error: "TimeoutError: send failed for ali@example.com +60123456789 key sk-abcdefghijklmno",
    });
    expect(entry.errorClass).toBe("TimeoutError");
    expect(entry.message).not.toContain("ali@example.com");
    expect(entry.message).not.toContain("60123456789");
    expect(entry.message).not.toContain("sk-abcdefghijklmno");
    expect(entry.correlationId).toBe(entry.id);
  });

  it("caps message length and falls back when empty", () => {
    const long = sanitizeErrorEntry({
      id: "a",
      created_at: "2026-09-01T00:00:00.000Z",
      error: "x".repeat(1000),
    });
    expect(long.message.length).toBeLessThanOrEqual(181);
    const empty = sanitizeErrorEntry({ id: "b", created_at: "2026-09-01T00:00:00.000Z", error: null });
    expect(empty.message).toBe("(no diagnostic detail)");
    expect(empty.errorClass).toBe("OperationalError");
  });

  it("exposes error class only for unknown throwables", () => {
    expect(errorClass(new TypeError("boom"))).toBe("TypeError");
    expect(errorClass("weird")).toBe("StringError");
    expect(errorClass(null)).toBe("UnknownError");
  });
});

describe("developer console — payload safety", () => {
  it("integration descriptors carry no credential material", () => {
    const item = integration("stripe", "Stripe billing", true, "Billing credentials configuration.");
    expect(containsForbiddenKeys(item)).toEqual([]);
    expect(JSON.stringify(item)).not.toMatch(/sk_|sb_secret|Bearer/);
  });

  it("static console sections contain no forbidden fields", () => {
    expect(containsForbiddenKeys(DEVELOPER_SECURITY_INDICATORS)).toEqual([]);
    expect(containsForbiddenKeys(DEVELOPER_TASKS)).toEqual([]);
  });

  it("detects forbidden keys when they would appear", () => {
    expect(containsForbiddenKeys({ nested: { access_token: "x" } })).toContain("nested.access_token");
    expect(containsForbiddenKeys({ list: [{ phone: "1" }] })).toContain("list.0.phone");
  });
});

describe("developer console — authorization posture", () => {
  it("developer access is independent of agency and platform_owner roles", async () => {
    const source = await Bun.file("src/lib/developer/developer.functions.ts").text();
    expect(source).toContain("requireSupabaseAuth");
    expect(source).toContain("developer_access");
    expect(source).toContain("Forbidden: developer access required");
    // Must not consult or grant platform ownership / agency roles.
    expect(source).not.toContain("platform_owner");
    expect(source).not.toContain("assertPlatformOwner");
  });

  it("console reads the allow-list through the caller's RLS-scoped client", async () => {
    const source = await Bun.file("src/lib/developer/developer.functions.ts").text();
    const assertBlock = source.slice(
      source.indexOf("async function assertDeveloper"),
      source.indexOf("function envRead"),
    );
    expect(assertBlock).not.toContain("supabaseAdmin");
    expect(assertBlock).toContain('.eq("active", true)');
  });

  it("Founder HQ modules are untouched by the developer layer", async () => {
    const hq = await Bun.file("src/lib/hq/hq.functions.ts").text();
    expect(hq).not.toContain("developer_access");
  });
});
