import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/public/health/opus-probe')({
  server: {
    handlers: {
      GET: async () => {
        const { OPUS_WASM_BASE64 } = await import('@/lib/voice/opus/opus-wasm.base64')
        let compile = 'ok'
        try {
          const bin = atob(OPUS_WASM_BASE64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          await WebAssembly.instantiate(await WebAssembly.compile(bytes), {})
        } catch (e) {
          compile = String((e as Error)?.message ?? e)
        }
        console.log('opus_probe_compile', compile)
        const { encodePcmToOggOpus, opusWasmSource } = await import('@/lib/voice/opus-encode.server')
        const pcm = new Uint8Array(24000 * 2 * 0.2 * 2)
        const r = await encodePcmToOggOpus(pcm)
        return Response.json(
          r.ok
            ? { ok: true, bytes: r.bytes.byteLength, source: opusWasmSource() }
            : { ...r, source: opusWasmSource() },
        )
      },
    },
  },
})
