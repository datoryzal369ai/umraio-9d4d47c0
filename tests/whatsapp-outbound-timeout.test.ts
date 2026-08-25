import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendWhatsappText } from "../src/lib/whatsapp-send.server";

describe("P1-2 — outbound Meta Graph calls are bounded by a timeout", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes an abort signal to every Meta request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    await sendWhatsappText("123", "token", "60123456789", "hello");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails cleanly (false, no throw) when the request aborts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const error = new Error("aborted");
        error.name = "AbortError";
        if (signal?.aborted) reject(error);
        signal?.addEventListener("abort", () => reject(error));
        // Simulate an abort firing while the request is in flight.
        (signal as AbortSignal & { dispatchAbort?: () => void }) &&
          setTimeout(() => reject(error), 0);
      });
    });
    const ok = await sendWhatsappText("123", "token", "60123456789", "hello");
    expect(ok).toBe(false);
  });
});
