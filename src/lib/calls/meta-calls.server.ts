/**
 * UMRAIO® — Meta Cloud API call-answer client (server only).
 *
 * The Worker is the ONLY holder of the Meta access token; the media gateway
 * never sees it. `accept` is sent with the REAL SDP answer produced by the
 * gateway. A non-2xx reply is a failure — it never yields "answered".
 */
const GRAPH = "https://graph.facebook.com/v21.0";

export type MetaAcceptResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function metaAcceptCall(args: {
  phoneNumberId: string;
  accessToken: string;
  callId: string;
  sdpAnswer: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MetaAcceptResult> {
  const doFetch = args.fetchImpl ?? fetch;
  if (!args.accessToken) return { ok: false, reason: "meta_token_missing" };
  if (!args.sdpAnswer?.trim()) return { ok: false, reason: "missing_sdp_answer" };

  let response: Response;
  try {
    response = await doFetch(`${GRAPH}/${encodeURIComponent(args.phoneNumberId)}/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        call_id: args.callId,
        action: "accept",
        session: { sdp_type: "answer", sdp: args.sdpAnswer },
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, reason: "meta_unreachable" };
  }

  if (!response.ok) {
    // Never log or surface the provider payload: it can echo credentials.
    return { ok: false, reason: `meta_accept_http_${response.status}` };
  }
  const parsed = (await response.json().catch(() => null)) as { success?: boolean } | null;
  if (parsed && parsed.success === false) return { ok: false, reason: "meta_accept_rejected" };
  return { ok: true };
}
