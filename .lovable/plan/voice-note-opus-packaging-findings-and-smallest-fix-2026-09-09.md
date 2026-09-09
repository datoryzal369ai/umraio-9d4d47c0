# Voice Note Opus packaging — findings and smallest fix

Read-only inspection of the published source. No code was changed.

## What the code does today

- `src/lib/voice/opus-encode.server.ts`
  - `loadCompiledModule()` — `await import("./opus/opus.wasm?cfmodule")`, expects a ready-made `WebAssembly.Module`.
  - `opusAllowsByteCompilation()` — returns `false` when `NODE_ENV === "production"`.
  - `loadOpusExports()` — if the compiled-module import fails in production it logs
    `opus_wasm_unavailable source=compiled_module reason=not_packaged` and returns null; the hosted-asset
    fetch (`/wasm/opus.wasm`) and the embedded base64 build are only reachable outside production.
  - Callers then log `minimax_opus_encode_failed fallback=none` and the voice note fails closed.
- `vite.config.ts` → `workerWasmModule()` rewrites `opus.wasm?cfmodule` into a relative **external** import `./opus.wasm`.
- `scripts/finalize-worker-wasm.mjs` (run only by the `build` / `build:dev` npm scripts) copies
  `src/lib/voice/opus/opus.wasm` next to any server chunk containing `"./opus.wasm"` and appends a
  `CompiledWasm` rule to `dist/server/wrangler.json`.
- Binary is present in the repo: `src/lib/voice/opus/opus.wasm` (331,172 bytes) and `public/wasm/opus.wasm`.

## Why it is absent from the published bundle

The hosting preset is `lovable-fetch-bundle` (`node_modules/@lovable.dev/vite-tanstack-config/dist/index.js`,
`lovableFetchBundlePreset()`), configured with `noExternals: true` and `inlineDynamicImports: true`, output to
`dist/server`. Consequences:

1. That preset is not a wrangler/Cloudflare-module deploy, so **no `dist/server/wrangler.json` exists** — the
   `CompiledWasm` rule the finaliser wants to register has nowhere to go, and the finaliser's
   "no wrangler config — skipped" branch is the expected outcome.
2. With `noExternals` + `inlineDynamicImports`, an external relative `./opus.wasm` specifier has **no module
   loader** at runtime; the dynamic import throws and `loadCompiledModule()` returns null.
3. It is also unverified whether the publish pipeline runs the `build` npm script at all (only that script
   invokes the finaliser). Either way, cause 1 and 2 are sufficient on their own.

So the current precompiled-module strategy cannot succeed on this hosting, and the production fail-closed rule
converts that into "no voice note sent".

## Options for the smallest fix

Both keep MiniMax, `speech-2.8-hd`, `Malay_male_1_v1`, `ms-MY`, native OGG/Opus delivery and the fail-closed
policy unchanged. No secret, provider or model change.

**Option 1 — reuse the voice gateway's native libopus (recommended).**
The Go gateway (`voice-gateway/internal/tts/opus_cgo.go`, `speaker.go`) already encodes MiniMax PCM to Opus with
native libopus and is live (`status=ok`, `speech=up`). Add a server-side call from the Voice Note path to an
existing/thin gateway encode endpoint, authenticated with the existing `WHATSAPP_MEDIA_GATEWAY_SECRET`. No WASM in
the Worker at all, so the packaging problem disappears permanently.
Risk: adds a network hop (gateway latency already ~ms-scale); requires one gateway endpoint if none exists.

**Option 2 — prove or drop runtime byte-compilation in the Worker.**
Confirm with the existing read-only probe route `src/routes/api/public/health/opus-probe.ts` whether
`WebAssembly.instantiate(bytes)` is genuinely blocked in the published runtime. If it is *not* blocked, the fix is
one line: allow the hosted-asset / embedded-base64 path in production (the binary is already served at
`/wasm/opus.wasm`). If it *is* blocked, Option 2 is dead and Option 1 is the only route.

Recommended order: run the probe first (read-only), then implement Option 1 unless the probe clears byte
compilation.

## Tests and checks required

- Existing: `tests/minimax-ogg-opus.test.ts`, `tests/opus-quality-settings.test.ts`,
  `tests/whatsapp-voice-reply-v1.test.ts`, `tests/whatsapp-voice-note-fail-closed.test.ts`.
- New focused test: the Voice Note path produces a valid OGG container (OggS magic, OpusHead, monotonic granule)
  via whichever encoder source the fix selects, and still fails closed when the encoder is unavailable.
- `bunx vitest run`, `tsgo`, production `vite build`, `git diff --check`; Go `build/vet/test` only if Option 1
  touches the gateway.
- Post-deploy acceptance: one real founder voice note, then confirm `tts_success engine=minimax` with an
  `audio/ogg` format line and no `opus_wasm_unavailable`.

## Existing branches

No open branch contains a fix for this. Remote heads: `main` (`9e65d8d4`, = published build),
`_agent-publish` (`8c812790`, same base plus `public/wasm/opus.wasm`), and
`codex/implement-founder-hq-call-observability-v1` (`111ccf8c`, older Opus files, no packaging work).
The PR #4 branch is no longer present on the remote.
