/**
 * UMRAIO® — media gateway -> control plane conversation turn endpoint.
 *
 * Same trust model as the lifecycle callback: every request must carry a valid
 * HMAC over "<unix-ts>.<raw body>" using the gateway shared secret, inside the
 * 5-minute skew window. The payload carries only a call_id and caller audio —
 * no agency identifier, no token, no credential. Tenancy is resolved from the
 * Worker's own call-session row.
 */
import { createFileRoute } from "@tanstack/react-router";
import { verifyGatewayCallbackSignature } from "@/lib/calls/gateway-auth.core";
import { parseVoiceTurnRequest, MAX_TURN_AUDIO_BASE64 } from "@/lib/calls/voice-turn.core";

/** Body ceiling: one base64 utterance plus envelope. */
const MAX_BODY_BYTES = MAX_TURN_AUDIO_BASE64 + 4 * 1024;

export const Route = createFileRoute("/api/public/voice/turn")({
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
          console.log(`[calls] voice_turn_unauthorized reason=${verified.reason}`);
          return new Response("unauthorized", { status: 401 });
        }

        let json: unknown = null;
        try {
          json = JSON.parse(rawBody);
        } catch {
          return new Response("invalid_payload", { status: 400 });
        }
        const payload = parseVoiceTurnRequest(json);
        if (!payload) return new Response("invalid_payload", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { handleVoiceTurn } = await import("@/lib/calls/voice-turn.server");

        try {
          const result = await handleVoiceTurn({ db: supabaseAdmin as never, payload });
          // A failed stage is an honest, audio-free 200: the gateway stays
          // silent instead of replaying an utterance that can never succeed.
          return Response.json(
            result.ok
              ? {
                  reply_ogg_base64: result.replyOggBase64 ?? "",
                  end_call: result.endCall,
                  reason: result.reason ?? "",
                }
              : { reply_ogg_base64: "", end_call: false, reason: result.reason },
          );
        } catch (error) {
          console.error(
            `[calls] voice_turn_failed call_id=${payload.call_id} reason=${error instanceof Error ? error.name : "unknown"}`,
          );
          return new Response("retry", { status: 500 });
        }
      },
    },
  },
});
