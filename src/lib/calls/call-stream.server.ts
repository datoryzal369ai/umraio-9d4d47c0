import type { VoiceTurnResult } from "./voice-turn.server";

export type CallingAcknowledgement = { text: string; voiceId: string; languageBoost: string };

function wire(result: VoiceTurnResult) {
  return result.ok ? {
    reply_ogg_base64: result.replyOggBase64 ?? "",
    speech_text: result.replyOggBase64 ? "" : result.text,
    voice_id: result.voiceId ?? "",
    language_boost: result.languageBoost ?? "",
    end_call: result.endCall,
    reason: result.reason ?? "",
    backchannel_texts: result.backchannelTexts ?? [],
  } : { reply_ogg_base64: "", speech_text: "", end_call: false, reason: result.reason };
}

/** Called only AFTER the existing endpoint verifies HMAC, bounds and tenancy payload. */
export async function callingTurnResponse(args: {
  streaming: boolean;
  signal: AbortSignal;
  run: (emit: ((ack: CallingAcknowledgement) => void) | undefined, signal: AbortSignal) => Promise<VoiceTurnResult>;
}): Promise<Response> {
  if (!args.streaming) return Response.json(wire(await args.run(undefined, args.signal)));
  const abort = new AbortController();
  const signal = AbortSignal.any([args.signal, abort.signal]);
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        if (!cancelled && !signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      };
      void args.run(ack => send({ type: "ack", speech_text: ack.text,
        voice_id: ack.voiceId, language_boost: ack.languageBoost, end_call: false }), signal)
        .then(result => send({ type: "final", ...wire(result) }))
        .catch(() => send({ type: "error", reason: "turn_failed" }))
        .finally(() => { if (!cancelled) controller.close(); });
    },
    cancel() { cancelled = true; abort.abort(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
  } });
}
