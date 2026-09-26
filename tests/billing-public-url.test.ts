/**
 * UMRAIO® — Subscription Stripe URLs must always point at the public
 * production site. Regression for the Forbidden redirect: the raw
 * PUBLIC_SITE_URL env value contained a preview/dev host, so RM299 checkout
 * success/cancel and the billing portal return landed on an access-protected
 * preview URL. Every billing origin must go through resolvePublicSiteUrl.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolvePublicSiteUrl } from "@/lib/quotations/public-url.core";

const CHECKOUT_SOURCE = readFileSync("src/lib/billing/checkout.functions.ts", "utf8");

describe("subscription billing public URL canonicalisation", () => {
  it("checkout session and billing portal both use resolvePublicSiteUrl", () => {
    expect(CHECKOUT_SOURCE.match(/resolvePublicSiteUrl\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("never falls back to the raw PUBLIC_SITE_URL env value", () => {
    expect(CHECKOUT_SOURCE).not.toMatch(/process\.env\["PUBLIC_SITE_URL"\]\s*\?\?/);
  });

  it("preview and dev hosts canonicalise to the production site", () => {
    expect(resolvePublicSiteUrl("https://project--34af2e6d-dev.lovable.app")).toBe(
      "https://umraio.com",
    );
    expect(resolvePublicSiteUrl("http://localhost:8080")).toBe("https://umraio.com");
    expect(resolvePublicSiteUrl(undefined)).toBe("https://umraio.com");
  });

  it("production host is preserved for the success, cancel and return URLs", () => {
    const origin = resolvePublicSiteUrl("https://umraio.com");
    expect(`${origin}/settings/subscription?checkout=success`).toMatch(/^https:\/\/umraio\.com\//);
    expect(`${origin}/settings/subscription`).toMatch(/^https:\/\/umraio\.com\//);
  });
});
