/**
 * UMRAIO® P0-1 — narrowly scoped duplicate suppression.
 *
 * Pure decision helpers only. They never change DNC semantics: a current-turn
 * STOP still applies do-not-contact, disables the AI and cancels follow-ups.
 * They only decide whether an IDENTICAL customer-facing message is repeated.
 */

/** Default repetition window for identical ASR-empty fallbacks. */
export const VOICE_FALLBACK_DEDUPE_WINDOW_MS = 120_000;

/**
 * The compliant DNC/handoff acknowledgement is sent exactly once — for the
 * actual state transition. A conversation already parked in that state must
 * not re-acknowledge on every subsequent inbound message.
 */
export function shouldSendSafetyAck(args: {
  currentState: string | null | undefined;
  targetState: "DO_NOT_CONTACT" | "HUMAN_HANDOFF";
}): boolean {
  return (args.currentState ?? null) !== args.targetState;
}

/**
 * True when an identical voice fallback (same sender, same reason) was already
 * sent inside the window. A legitimate later fallback after the window passes.
 */
export function shouldSuppressVoiceFallback(args: {
  previous: { from?: string | null; reason?: string | null; createdAt?: string | null } | null;
  from: string;
  reason: string;
  now?: number;
  windowMs?: number;
}): boolean {
  const { previous, from, reason } = args;
  if (!previous) return false;
  if ((previous.from ?? null) !== from) return false;
  if ((previous.reason ?? null) !== reason) return false;
  const windowMs = args.windowMs ?? VOICE_FALLBACK_DEDUPE_WINDOW_MS;
  if (!previous.createdAt) return true;
  const at = Date.parse(previous.createdAt);
  if (Number.isNaN(at)) return true;
  const now = args.now ?? Date.now();
  return now - at < windowMs;
}
