/** Offline validation fixture: the exact repository WASM, with no product or assertion changes. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const original = globalThis.fetch;
const wasm = readFileSync(resolve("public/wasm/opus.wasm"));
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://umraio.com/wasm/opus.wasm") {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return Promise.resolve(new Response(wasm, { headers: { "Content-Type": "application/wasm" } }));
  }
  return original(input, init);
}) as typeof fetch;
