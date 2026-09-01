/**
 * UMRAIO® — media gateway -> control plane callback endpoint.
 *
 * This is NOT browser callable in any meaningful sense: every request must
 * carry a valid HMAC over "<unix-ts>.<raw body>" using the gateway shared
 * secret, within a 5-minute skew window. It performs no privileged action on
 * behalf of a user, accepts no agency identifier, and returns no tenant data.
 */
import { createFileRoute } from "@tanstack/react-router";
import { verifyGatewayCallbackSignature } from "@/lib/calls/gateway-auth.core";
import { parseGatewayCallback } from "@/lib/calls/gateway-callback.core";

const MAX_BODY_BYTES = 16 * 1024;

export const Route = createFileRoute("/api/internal/voice/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["WHATSAPP_MEDIA_GATEWAY_SECRET"]?.trim() ?? "";
        if (!secret) return new Response("unavailable", { status: 503 });

        const rawBody = await request.text();
        if (rawBody.length > MAX_BODY_BYTES) return new Response("too_large", { status: 413 });

        const verified = await verifyGatewayCallbackSignature({
          secret,
          signature: request.headers.get("x-umraio-signature"),
          timestamp: request.headers.get("x-umraio-timestamp"),
          rawBody,
        });
        if (!verified.ok) {
          console.log(`[calls] gateway_callback_unauthorized reason=${verified.reason}`);
          return new Response("unauthorized", { status: 401 });
        }

        let json: unknown = null;
        try {
          json = JSON.parse(rawBody);
        } catch {
          return new Response("invalid_payload", { status: 400 });
        }
        const payload = parseGatewayCallback(json);
        if (!payload) return new Response("invalid_payload", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { processGatewayCallback } = await import("@/lib/calls/calls.server");

        try {
          const result = await processGatewayCallback({ db: supabaseAdmin as never, payload });
          // A rejected-but-authentic event is still consumed: replying 2xx stops
          // the gateway retrying an event that can never become applicable.
          return Response.json(
            result.applied
              ? { ok: true, applied: true, outcome: result.outcome }
              : { ok: true, applied: false, reason: result.rejection },
          );
        } catch (error) {
          console.error(
            `[calls] gateway_callback_failed call_id=${payload.call_id} reason=${error instanceof Error ? error.name : "unknown"}`,
          );
          return new Response("retry", { status: 500 });
        }
      },
    },
  },
});
