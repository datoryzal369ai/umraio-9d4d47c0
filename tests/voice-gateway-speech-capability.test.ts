/**
 * P0 regression: a media plane without the speech capability accepts calls and
 * stays silent, which the caller sees as "No answer". probeGatewaySpeech must
 * report that state truthfully from the public /health contract.
 */
import { describe, expect, it } from "vitest";
import { probeGatewaySpeech } from "@/lib/calls/media-gateway.server";

function health(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: ok ? 200 : 503 })) as unknown as typeof fetch;
}

describe("probeGatewaySpeech", () => {
  it("reports up only when the gateway declares speech capability", async () => {
    const result = await probeGatewaySpeech({
      gatewayUrl: "https://gateway.test",
      fetchImpl: health({ status: "ok", webrtc: "up", speech: "up" }),
    });
    expect(result).toBe("up");
  });

  it("reports down for a build that predates media-plane synthesis", async () => {
    const result = await probeGatewaySpeech({
      gatewayUrl: "https://gateway.test/",
      fetchImpl: health({ status: "ok", webrtc: "up", build_version: "f0b0333" }),
    });
    expect(result).toBe("down");
  });

  it("reports down when the gateway explicitly declares speech down", async () => {
    const result = await probeGatewaySpeech({
      gatewayUrl: "https://gateway.test",
      fetchImpl: health({ status: "ok", speech: "down" }),
    });
    expect(result).toBe("down");
  });

  it("reports unknown when health is unreachable", async () => {
    const result = await probeGatewaySpeech({
      gatewayUrl: "https://gateway.test",
      fetchImpl: (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
    });
    expect(result).toBe("unknown");
  });
});
