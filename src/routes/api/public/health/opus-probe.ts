import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/public/health/opus-probe')({
  server: {
    handlers: {
      GET: async () => {
        const { encodePcmToOggOpus } = await import('@/lib/voice/opus-encode.server')
        const pcm = new Uint8Array(24000 * 2 * 0.2 * 2)
        const r = await encodePcmToOggOpus(pcm)
        return Response.json(r.ok ? { ok: true, bytes: r.bytes.byteLength } : r)
      },
    },
  },
})
