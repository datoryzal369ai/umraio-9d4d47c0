import { createFileRoute } from '@tanstack/react-router'

/** 0.2 s of synthetic s16le / 24 kHz / mono tone — never customer audio. */
function syntheticPcm(): Uint8Array {
  const pcm = new Uint8Array(24000 * 0.2 * 2)
  const view = new DataView(pcm.buffer)
  for (let i = 0; i < pcm.byteLength / 2; i++) {
    view.setInt16(i * 2, Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / 24000)), true)
  }
  return pcm
}

/**
 * Non-secret Opus encoder diagnostic. Synthetic PCM only — no provider call,
 * no database read, no customer data. Separates the three failure classes that
 * were previously collapsed into "not_packaged":
 *   1. byte compilation banned by the embedder,
 *   2. precompiled module not shipped / not importable,
 *   3. instantiation failing on missing WASI imports.
 */
export const Route = createFileRoute('/api/public/health/opus-probe')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const runtime = {
          navigator: typeof navigator === 'undefined' ? 'none' : String((navigator as { userAgent?: string }).userAgent ?? 'unknown'),
          node_env: process.env['NODE_ENV'] ?? 'unset',
          has_process_versions: typeof process !== 'undefined' && Boolean((process as { versions?: unknown }).versions),
        }

        /**
         * NATIVE CONVERTER PROBE — off by default AND loopback-only. Two
         * independent conditions must hold: the explicit non-production opt-in,
         * and a configured media-plane URL that resolves to loopback. A public
         * probe therefore cannot reach the production media plane even if the
         * opt-in flag is set by accident.
         */
        const wantsGateway = new URL(request.url).searchParams.get('mode') === 'gateway'
        const optIn = process.env['OPUS_PROBE_ALLOW_GATEWAY'] === '1'
        const { resolveOpusGatewayConfig, isLoopbackGatewayUrl } = await import(
          '@/lib/voice/opus-gateway.server'
        )
        const gatewayConfig = resolveOpusGatewayConfig()
        const loopback = isLoopbackGatewayUrl(gatewayConfig?.gatewayUrl)
        if (wantsGateway && optIn && loopback) {
          const configured = Boolean(gatewayConfig)
          const { encodeVoiceNotePcm } = await import('@/lib/voice/voice-note-encode.server')
          const pcm = syntheticPcm()
          const out = await encodeVoiceNotePcm(pcm)

          return Response.json({
            ok: out.ok,
            runtime,
            mode: 'gateway',
            gateway_configured: configured,
            encoder: out.source,
            ...(out.ok
              ? {
                  mime_type: 'audio/ogg',
                  container: {
                    magic: String.fromCharCode(...out.bytes.subarray(0, 4)),
                    opus_head: String.fromCharCode(...out.bytes.subarray(28, 36)),
                    bytes: out.bytes.byteLength,
                  },
                }
              : { reason: out.reason }),
          })
        }
        if (wantsGateway) {
          return Response.json({ ok: false, runtime, mode: 'gateway', reason: 'gateway_probe_disabled' })
        }

        const { OPUS_WASM_BASE64 } = await import('@/lib/voice/opus/opus-wasm.base64')
        const bin = atob(OPUS_WASM_BASE64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

        // Stage: compile only (no imports involved).
        let compile = 'ok'
        let compiled: WebAssembly.Module | null = null
        try {
          compiled = await WebAssembly.compile(bytes)
        } catch (e) {
          compile = String((e as Error)?.message ?? e).slice(0, 200)
        }

        // Stage: instantiate the compiled module with the REQUIRED imports, so a
        // missing-import failure is never misread as a code-generation ban.
        let instantiate = compiled ? 'ok' : 'skipped_no_module'
        if (compiled) {
          try {
            const { OPUS_IMPORTS } = await import('@/lib/voice/opus-encode.server')
            await WebAssembly.instantiate(compiled, OPUS_IMPORTS)
          } catch (e) {
            instantiate = String((e as Error)?.message ?? e).slice(0, 200)
          }
        }

        const { encodePcmToOggOpus, opusWasmSource, opusLoaderStages } = await import(
          '@/lib/voice/opus-encode.server'
        )
        const pcm = syntheticPcm()
        const r = await encodePcmToOggOpus(pcm)

        const container = r.ok
          ? {
              magic: String.fromCharCode(...r.bytes.subarray(0, 4)),
              opus_head: String.fromCharCode(...r.bytes.subarray(28, 36)),
              bytes: r.bytes.byteLength,
            }
          : null

        console.log('opus_probe', JSON.stringify({ compile, instantiate, stages: opusLoaderStages() }))

        return Response.json({
          ok: r.ok,
          runtime,
          embedded_wasm_bytes: bytes.byteLength,
          compile,
          instantiate,
          source: opusWasmSource(),
          stages: opusLoaderStages(),
          ...(r.ok ? { container } : { reason: r.reason }),
        })
      },
    },
  },
})
