/**
 * UMRAIO® — P-1A callback route relocation tests.
 *
 * Proves the two media-gateway callback handlers are reachable ONLY at
 * /api/public/voice/*, that the old /api/internal/voice/* processing paths
 * are gone, and that the relocated handlers keep fail-closed authentication
 * (missing/invalid HMAC rejected before any privileged work).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Route as EventsRoute } from "@/routes/api/public/voice/events";
import { Route as TurnRoute } from "@/routes/api/public/voice/turn";

const ROOT = join(__dirname, "..");

describe("P-1A callback route relocation", () => {
  it("exposes the events handler at /api/public/voice/events", () => {
    expect((EventsRoute as unknown as { fullPath: string }).fullPath).toBe(
      "/api/public/voice/events",
    );
  });

  it("exposes the turn handler at /api/public/voice/turn", () => {
    expect((TurnRoute as unknown as { fullPath: string }).fullPath).toBe(
      "/api/public/voice/turn",
    );
  });

  it("leaves no second processing path at the old internal routes", () => {
    expect(existsSync(join(ROOT, "src/routes/api/internal/voice/events.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src/routes/api/internal/voice/turn.ts"))).toBe(false);
    const tree = readFileSync(join(ROOT, "src/routeTree.gen.ts"), "utf8");
    expect(tree).not.toContain("api/internal/voice");
  });

  it("gateway callback URLs point at the public paths only", () => {
    const client = readFileSync(
      join(ROOT, "voice-gateway/internal/callback/client.go"),
      "utf8",
    );
    const turn = readFileSync(join(ROOT, "voice-gateway/internal/callback/turn.go"), "utf8");
    expect(client).toContain('"/api/public/voice/events"');
    expect(turn).toContain('"/api/public/voice/turn"');
    expect(client).not.toContain("/api/internal/voice");
    expect(turn).not.toContain("/api/internal/voice");
  });

  it("events handler is fail-closed without a valid HMAC signature", async () => {
    const prev = process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"];
    process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"] = "test-secret-0123456789abcdef";
    try {
      const handlers = (EventsRoute.options.server as { handlers: Record<string, Function> })
        .handlers;
      const res = await handlers.POST!({
        request: new Request("http://localhost/api/public/voice/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "answered" }),
        }),
        params: {},
        context: {},
      });
      expect(res.status).toBe(401);
      // Browser-style GET is not even defined.
      expect(handlers.GET).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"];
      else process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"] = prev;
    }
  });

  it("turn handler is fail-closed without a valid HMAC signature", async () => {
    const prev = process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"];
    process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"] = "test-secret-0123456789abcdef";
    try {
      const handlers = (TurnRoute.options.server as { handlers: Record<string, Function> })
        .handlers;
      const res = await handlers.POST!({
        request: new Request("http://localhost/api/public/voice/turn", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-umraio-signature": "sha256=deadbeef",
            "x-umraio-timestamp": String(Math.floor(Date.now() / 1000)),
          },
          body: JSON.stringify({ call_id: "wacid.fake" }),
        }),
        params: {},
        context: {},
      });
      expect(res.status).toBe(401);
      expect(handlers.GET).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"];
      else process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"] = prev;
    }
  });

  it("events handler fails closed when the gateway secret is not configured", async () => {
    const prev = process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"];
    delete process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"];
    try {
      const handlers = (EventsRoute.options.server as { handlers: Record<string, Function> })
        .handlers;
      const res = await handlers.POST!({
        request: new Request("http://localhost/api/public/voice/events", {
          method: "POST",
          body: "{}",
        }),
        params: {},
        context: {},
      });
      expect(res.status).toBe(503);
    } finally {
      if (prev !== undefined) process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"] = prev;
    }
  });
});
