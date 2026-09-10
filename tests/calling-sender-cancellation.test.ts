import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { sendWhatsappTextDetailed } from "../src/lib/whatsapp-send.server";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const send = (signal?: AbortSignal, timeoutMs = 12000) => signal
  ? sendWhatsappTextDetailed("synthetic", "synthetic", "60123456789", "Synthetic document", { signal, timeoutMs })
  : sendWhatsappTextDetailed("synthetic", "synthetic", "60123456789", "Synthetic document");

describe("optional Calling sender lifetime", () => {
  it("retains the exact legacy no-signal behaviour, including its baseline header-only timeout", async () => {
    vi.useFakeTimers();
    let release!: ReadableStreamDefaultController<Uint8Array>; let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { signal = init.signal; return new Response(new ReadableStream({ start(c) { release = c; } })); }));
    let completed = false;
    const pending = send().finally(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(25000);
    expect({ completed, aborted: signal.aborted }).toEqual({ completed: false, aborted: false });
    release.enqueue(new TextEncoder().encode('{"messages":[{"id":"wamid.legacy"}]}')); release.close();
    expect(await pending).toEqual({ ok: true, providerMessageId: "wamid.legacy" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(Array.from({ length: 20 }, (_, i) => i))("cancels concurrent reads without detached work, false failure or duplicate dispatch %i", async index => {
    vi.useFakeTimers();
    let bodyErrors = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Response(new ReadableStream({ start(c) {
      init.signal.addEventListener("abort", () => { bodyErrors++; c.error(init.signal.reason); }, { once: true });
    } }))));
    const caller = new AbortController(); const deadline = new AbortController();
    const pending = [send(caller.signal, 100), send(deadline.signal, 100)];
    await vi.advanceTimersByTimeAsync(index % 5);
    caller.abort(new DOMException("Caller cancellation", "AbortError"));
    await vi.advanceTimersByTimeAsync(100);
    const [cancelled, timedOut] = await Promise.all(pending);
    expect(cancelled).toMatchObject({ ok: false, outcome: "outcome_unknown", cause: "cancelled", dispatched: true });
    expect(timedOut).toMatchObject({ ok: false, outcome: "outcome_unknown", cause: "timeout", dispatched: true });
    expect(bodyErrors).toBe(2); expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["AbortError", "TimeoutError"])("distinguishes %s before dispatch from unknown provider outcome", async name => {
    const controller = new AbortController(); controller.abort(new DOMException("Synthetic cancellation", name));
    vi.stubGlobal("fetch", vi.fn());
    expect(await send(controller.signal)).toMatchObject({ outcome: name === "TimeoutError" ? "timeout" : "cancelled", dispatched: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [200, { messages: [{ id: "wamid.verified" }] }, "verified_success", true],
    [200, {}, "outcome_unknown", false],
    [400, { error: { code: 100 } }, "verified_failure", false],
    [500, { error: { code: 2 } }, "outcome_unknown", false],
    [408, { error: { code: 2 } }, "outcome_unknown", false],
  ] as const)("classifies complete provider evidence: HTTP %i", async (status, body, outcome, ok) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
    expect(await send(new AbortController().signal)).toMatchObject({ ok, outcome });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts a real fetch response-body read and closes the local provider socket", async () => {
    let headersReady!: () => void; let providerClosed!: () => void;
    const headers = new Promise<void>(resolve => { headersReady = resolve; });
    const closed = new Promise<void>(resolve => { providerClosed = resolve; });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"messages":[');
      res.on("close", providerClosed); headersReady();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const actualFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((_url, init) => actualFetch(`http://127.0.0.1:${address.port}`, init)));
    const owner = new AbortController();
    try {
      const pending = send(owner.signal); await headers; owner.abort();
      expect(await pending).toMatchObject({ outcome: "outcome_unknown", cause: "cancelled", dispatched: true });
      await closed; expect(fetch).toHaveBeenCalledTimes(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
