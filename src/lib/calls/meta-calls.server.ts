/**
 * UMRAIO® — Meta Cloud API call-answer client (server only).
 *
 * The Worker is the ONLY holder of the Meta access token; the media gateway
 * never sees it. Both `pre_accept` and `accept` are sent with the REAL SDP
 * answer produced by the gateway, and per the Calling API reference the SDP
 * sent on `accept` MUST be byte-identical to the one sent on `pre_accept`.
 * A non-2xx reply is a failure — it never yields "answered".
 */
const GRAPH = "https://graph.facebook.com/v21.0";

export type MetaAcceptResult =
  | { ok: true }
  | { ok: false; reason: string };

export type MetaCallAction = "pre_accept" | "accept" | "terminate";

type MetaCallActionArgs = {
  action: MetaCallAction;
  phoneNumberId: string;
  accessToken: string;
  callId: string;
  /** Required for pre_accept/accept; unused (and omitted) for terminate. */
  sdpAnswer?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Sends one Meta call action with the gateway's real SDP answer.
 * Payload shape follows the official Calling API reference:
 *   { messaging_product, call_id, action, session: { sdp_type: "answer", sdp } }
 */
export async function metaCallAction(args: MetaCallActionArgs): Promise<MetaAcceptResult> {
  const doFetch = args.fetchImpl ?? fetch;
  if (!args.accessToken) return { ok: false, reason: "meta_token_missing" };
  const isTerminate = args.action === "terminate";
  if (!isTerminate && !args.sdpAnswer?.trim()) return { ok: false, reason: "missing_sdp_answer" };

  const timeoutSignal = AbortSignal.timeout(args.timeoutMs ?? 10_000);
  const signal =
    args.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([timeoutSignal, args.signal])
      : timeoutSignal;

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
        action: args.action,
        // `terminate` carries no session: it is a pure control action.
        ...(isTerminate ? {} : { session: { sdp_type: "answer", sdp: args.sdpAnswer } }),
      }),
      signal,
    });
  } catch {
    if (args.signal?.aborted) return { ok: false, reason: `meta_${args.action}_cancelled` };
    return { ok: false, reason: "meta_unreachable" };
  }

  if (!response.ok) {
    // Never log or surface the provider payload: it can echo credentials.
    return { ok: false, reason: `meta_${args.action}_http_${response.status}` };
  }
  const parsed = (await response.json().catch(() => null)) as { success?: boolean } | null;
  if (parsed && parsed.success === false) return { ok: false, reason: `meta_${args.action}_rejected` };
  return { ok: true };
}

/**
 * Pre-accept: establishes the WebRTC/ICE/DTLS path BEFORE the final accept so
 * media is already flowing-capable when the call is answered. Recommended by
 * Meta to avoid audio clipping and setup-timeout hangups.
 */
export function metaPreAcceptCall(args: Omit<MetaCallActionArgs, "action">): Promise<MetaAcceptResult> {
  return metaCallAction({ ...args, action: "pre_accept" });
}

/** Final accept. Must carry the SAME SDP answer used for pre_accept. */
export function metaAcceptCall(args: Omit<MetaCallActionArgs, "action">): Promise<MetaAcceptResult> {
  return metaCallAction({ ...args, action: "accept" });
}

/**
 * Graceful hang-up. Sent when the conversation completes naturally so the
 * WhatsApp call ends on Meta's side instead of lingering until a timeout.
 * Best-effort by contract: a failure never changes persisted call truth.
 */
export function metaTerminateCall(
  args: Omit<MetaCallActionArgs, "action" | "sdpAnswer">,
): Promise<MetaAcceptResult> {
  return metaCallAction({ ...args, action: "terminate" });
}
