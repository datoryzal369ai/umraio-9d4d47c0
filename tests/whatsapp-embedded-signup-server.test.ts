import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  exchangeEmbeddedSignupCode,
  subscribeAppToWaba,
} from "@/lib/whatsapp/embedded-signup.server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

function stubCredentials() {
  vi.stubEnv("META_APP_ID", "app-id");
  vi.stubEnv("META_APP_SECRET", "app-secret");
}

describe("meta token exchange", () => {
  it("returns the token on success and never puts the secret in the response", async () => {
    stubCredentials();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "TOKEN" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(exchangeEmbeddedSignupCode("code")).resolves.toBe("TOKEN");
  });

  it("throws a safe error when Meta rejects the code", async () => {
    stubCredentials();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "bad code" } }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(exchangeEmbeddedSignupCode("code")).rejects.toThrow(
      /Meta rejected the connection request/,
    );
  });

  it("throws when the app cannot subscribe to the WABA", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(subscribeAppToWaba("waba", "TOKEN")).rejects.toThrow(
      /Could not finish connecting WhatsApp/,
    );
  });
});

describe("server function safety contract", () => {
  const source = readFileSync("src/lib/whatsapp/embedded-signup.functions.ts", "utf8");

  it("derives agency_id from the authenticated profile, never from input", () => {
    expect(source).toContain("requireSupabaseAuth");
    expect(source).toContain('.from("profiles")');
    expect(source).toContain('.eq("id", userId)');
    expect(source).not.toMatch(/input\.agencyId|data\.agencyId/);
  });

  it("writes credentials only after the exchange and subscription succeed", () => {
    const exchangeIdx = source.indexOf("exchangeEmbeddedSignupCode(data.code)");
    const subscribeIdx = source.indexOf("subscribeAppToWaba(");
    const writeIdx = source.indexOf('.from("whatsapp_configs")');
    expect(exchangeIdx).toBeGreaterThan(-1);
    expect(subscribeIdx).toBeGreaterThan(exchangeIdx);
    expect(writeIdx).toBeGreaterThan(subscribeIdx);
  });

  it("never returns the access token to the browser", () => {
    const returned = source.slice(source.lastIndexOf("return {"));
    expect(returned).not.toContain("accessToken");
  });
});
