import { afterEach, expect, it, vi } from "vitest";
import { sendWhatsappTextDetailed } from "../src/lib/whatsapp-send.server";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Required receipt-lifetime gate. Synthetic transport only; the existing governed sender is unchanged. */
it("bounds the complete governed send, including a stalled response body after HTTP headers", async () => {
  vi.useFakeTimers();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let transportSignal!: AbortSignal;
  let headersReady!: () => void;
  const headers = new Promise<void>(resolve => { headersReady = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    transportSignal = init.signal!;
    headersReady();
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller;
      transportSignal.addEventListener("abort", () => controller.error(transportSignal.reason), { once: true });
    } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  let settled = false;
  const sent = sendWhatsappTextDetailed("synthetic-phone-id", "synthetic-test-credential", "60123456789", "Synthetic test quotation")
    .finally(() => { settled = true; });
  await headers;
  await vi.advanceTimersByTimeAsync(25_000);
  try {
    // The advertised 12-second request bound must cover receipt consumption,
    // within the Calling retained-operation budget, not just response headers.
    expect({ transportAborted: transportSignal.aborted, operationSettled: settled })
      .toEqual({ transportAborted: true, operationSettled: true });
  } finally {
    // Release the synthetic stream even when this baseline gate fails. No detached test work.
    if (!transportSignal.aborted) {
      body.enqueue(new TextEncoder().encode(JSON.stringify({ messages: [{ id: "synthetic-receipt" }] })));
      body.close();
    }
    await sent;
  }
});
