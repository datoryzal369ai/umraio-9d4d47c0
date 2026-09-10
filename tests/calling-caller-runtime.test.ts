/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { binding, bridgeDatabase, bridgeTestRequire, digest, receivedAt } from "./helpers/calling-bridge-db";
import { bindingArgs } from "../src/lib/calls/caller-turn-ledger.server";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("Calling Phase 1 in workerd: response cancellation cannot erase completed ASR", () => {
  let store: Awaited<ReturnType<typeof bridgeDatabase>>;
  let mf: any;
  const cases = new Map<number, { asrReached: ReturnType<typeof deferred<void>>; asrRelease: ReturnType<typeof deferred<void>>;
    persisted: ReturnType<typeof deferred<any>>; cancelled: ReturnType<typeof deferred<void>> }>();
  beforeAll(async () => {
    store = await bridgeDatabase();
    await store.rpc("calling_bridge_begin", { ...bindingArgs(binding), p_sequence: 1, p_greeting: true, p_received_at: receivedAt, p_request_digest: digest });
    const { Miniflare } = bridgeTestRequire("miniflare");
    const { transpileModule, ModuleKind, ScriptTarget } = createRequire(resolve("package.json"))("typescript");
    const source = ["calling-lifetime.server.ts", "caller-turn-ledger.server.ts"].map(file => {
      const compiled = transpileModule(readFileSync(resolve("src/lib/calls", file), "utf8"), {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      }).outputText;
      return compiled.replace(/^import .*;\s*$/gm, "");
    }).join("\n");
    mf = new Miniflare({ modules: true, compatibilityDate: "2026-05-15", script: `${source}
      export default { async fetch(request, env, context) {
        // Identical ownership hook supplied by the installed Nitro Cloudflare adapter.
        request.waitUntil = context.waitUntil.bind(context);
        const sequence = Number(new URL(request.url).pathname.slice(1));
        const assistant = new AbortController();
        const db = { rpc(name,args) { return { async abortSignal(signal) {
          const response = await env.TEST.fetch(new Request('https://fixture/rpc', {method:'POST',body:JSON.stringify({name,args}),signal}));
          return response.json();
        } }; } };
        const result = retainCallerTurn({db, binding:${JSON.stringify(binding)}, sequence, greeting:false,
          receivedAt:${JSON.stringify(receivedAt)}, durationMs:1200, requestDigest:${JSON.stringify(digest)}, lifetime:callingLifetime(request),
          asr: async signal => {
            const response = await env.TEST.fetch(new Request('https://fixture/asr/'+sequence, {signal}));
            return response.json();
          } });
        const stream = new ReadableStream({start(controller) {
          controller.enqueue(new TextEncoder().encode('processing\\n'));
          result.then(value => { if(!assistant.signal.aborted) {controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));controller.close();} })
            .catch(error => { if(!assistant.signal.aborted) controller.error(error); });
        },cancel() { assistant.abort(); context.waitUntil(env.TEST.fetch('https://fixture/cancel/'+sequence)); }});
        return new Response(stream, { headers: { 'Content-Type':'application/x-ndjson', 'Content-Encoding':'identity', 'Cache-Control':'no-store' } });
      } }`, serviceBindings: { TEST: async (request: Request) => {
        const path = new URL(request.url).pathname.split("/");
        if (path[1] === "asr") {
          const seq = Number(path[2]); const test = cases.get(seq)!;
          test.asrReached.resolve(); await test.asrRelease.promise;
          return Response.json({ text: `caller-${seq}`, durationSeconds: 1.2, language: "ms", confidence: "unknown", provider: "synthetic", model: "unchanged" });
        }
        if (path[1] === "cancel") { cases.get(Number(path[2]))!.cancelled.resolve(); return new Response("ok"); }
        const { name, args } = await request.json() as any;
        try {
          const data = await store.rpc(name, args);
          if (name === "calling_bridge_persist_caller") cases.get(args.p_sequence)!.persisted.resolve(data);
          return Response.json({ data, error: null });
        } catch (error: any) { return Response.json({ data: null, error: { code: error.code } }); }
      } } });
    await mf.ready;
  }, 30000);
  afterAll(async () => { await mf?.dispose(); await store?.pg.close(); });

  it.each(Array.from({ length: 20 }, (_, i) => i + 2))("retains ASR/persistence after cancelling the actual Worker stream, sequence %i", async sequence => {
    const test = { asrReached: deferred<void>(), asrRelease: deferred<void>(), persisted: deferred<any>(), cancelled: deferred<void>() };
    cases.set(sequence, test);
    const client = new AbortController();
    const response = await fetch(new URL(String(sequence), await mf.ready), { signal: client.signal, headers: { 'Accept-Encoding':'identity' } });
    const reader = response.body!.getReader();
    await test.asrReached.promise;
    client.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    test.asrRelease.resolve();
    const saved = await test.persisted.promise;
    expect(saved.turn.transcript).toBe(`caller-${sequence}`);
    const query = await store.pg.query("SELECT count(*)::int AS n FROM calling_caller_turns WHERE sequence=$1", [sequence]);
    expect(query.rows[0].n).toBe(1);
  });
});
