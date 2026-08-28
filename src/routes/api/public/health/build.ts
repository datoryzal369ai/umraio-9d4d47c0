import { createFileRoute } from "@tanstack/react-router";

import { BUILD_HEADER_VALUE, BUILD_IDENTITY } from "@/lib/build-identity";

/**
 * Y-6 — build/deployment traceability probe.
 *
 * Read-only diagnostic: returns only the build identity (commit, build time,
 * environment, version). No secrets, credentials or customer/lead/quotation
 * data ever appear in this payload.
 */
export const Route = createFileRoute("/api/public/health/build")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify(BUILD_IDENTITY), {
          status: BUILD_IDENTITY.ok ? 200 : 503,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-UMRAIO-Build": BUILD_HEADER_VALUE,
          },
        }),
    },
  },
});
