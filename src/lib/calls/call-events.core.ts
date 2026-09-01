/**
 * UMRAIO® — inbound WhatsApp call events (pure, deterministic core).
 *
 * This module ONLY interprets what Meta actually sent. It never assumes a call
 * was answered: `answered` is reachable only from an explicit Meta-confirmed
 * establishment event or a confirmed answer API result.
 */

export type MetaCallEvent = {
  id?: string;
  from?: string;
  to?: string;
  event?: string;
  direction?: string;
  status?: string;
  timestamp?: string;
  session?: { sdp_type?: string; sdp?: string };
};

export type CallSessionStatus =
  | "ringing"
  | "answer_requested"
  | "answered"
  | "missed"
  | "terminated"
  | "failed";

export type ParsedCallEvent = {
  callId: string;
  callerPhone: string;
  status: CallSessionStatus;
  direction: "inbound" | "outbound";
  /** Meta-supplied SDP offer, when present. Never fabricated. */
  sdp: { type: string; sdp: string } | null;
  terminationReason: string | null;
  occurredAt: string;
};

const RANK: Record<CallSessionStatus, number> = {
  ringing: 0,
  answer_requested: 1,
  answered: 2,
  missed: 3,
  terminated: 3,
  failed: 3,
};

export const TERMINAL_CALL_STATUSES: CallSessionStatus[] = ["answered", "missed", "terminated", "failed"];

/** Default bounded answer window (~3 rings). */
export const CALL_ANSWER_DELAY_MS = 8_000;

export function isTerminalCallStatus(status: string | null | undefined): boolean {
  return status === "missed" || status === "terminated" || status === "failed";
}

/**
 * Monotonic state machine: a call can never regress (a late `connect` retry
 * cannot un-terminate a hung-up call), and a terminal outcome cannot be
 * overwritten by another terminal outcome.
 */
export function shouldApplyCallStatus(
  current: string | null | undefined,
  incoming: CallSessionStatus,
): boolean {
  if (!current) return true;
  const currentRank = RANK[current as CallSessionStatus];
  if (currentRank === undefined) return true;
  if (isTerminalCallStatus(current) || current === "answered") return false;
  return RANK[incoming] > currentRank;
}

function normalizeTimestamp(raw: string | undefined): string {
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric * 1000).toISOString();
  }
  return new Date().toISOString();
}

/** Maps a raw Meta `calls[]` entry to our internal event, or null if unusable. */
export function parseCallEvent(raw: MetaCallEvent | null | undefined): ParsedCallEvent | null {
  if (!raw) return null;
  const callId = raw.id?.trim();
  const callerPhone = raw.from?.trim();
  if (!callId || !callerPhone) return null;

  const event = (raw.event ?? "").trim().toLowerCase();
  const metaStatus = (raw.status ?? "").trim().toUpperCase();
  const direction = (raw.direction ?? "").toUpperCase() === "BUSINESS_INITIATED" ? "outbound" : "inbound";

  let status: CallSessionStatus;
  let terminationReason: string | null = null;
  if (event === "connect") {
    status = "ringing";
  } else if (event === "terminate") {
    if (metaStatus === "COMPLETED") {
      status = "terminated";
      terminationReason = "completed";
    } else if (metaStatus === "FAILED") {
      status = "failed";
      terminationReason = "failed";
    } else {
      status = "missed";
      terminationReason = metaStatus ? metaStatus.toLowerCase() : "caller_hangup";
    }
  } else {
    return null;
  }

  const sdpValue = raw.session?.sdp?.trim();
  const sdp = sdpValue ? { type: raw.session?.sdp_type?.trim() || "offer", sdp: sdpValue } : null;

  return {
    callId,
    callerPhone,
    status,
    direction,
    sdp,
    terminationReason,
    occurredAt: normalizeTimestamp(raw.timestamp),
  };
}

export function extractCallEvents(calls: MetaCallEvent[] | undefined | null): ParsedCallEvent[] {
  const out: ParsedCallEvent[] = [];
  for (const raw of calls ?? []) {
    const parsed = parseCallEvent(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export type MediaCapability =
  | { supported: true; gatewayUrl: string }
  | { supported: false; reason: "media_gateway_required" };

/**
 * The Cloudflare Worker runtime cannot terminate a Meta call: no UDP/ICE, no
 * SRTP, no persistent duplex Opus stream. Answering is therefore only possible
 * when an external media gateway is configured. Absent one, we record the
 * bounded answer window and stop — we never claim the call was answered.
 */
export function resolveMediaCapability(env: Record<string, string | undefined>): MediaCapability {
  const url = env["WHATSAPP_MEDIA_GATEWAY_URL"]?.trim();
  if (url) return { supported: true, gatewayUrl: url };
  return { supported: false, reason: "media_gateway_required" };
}
