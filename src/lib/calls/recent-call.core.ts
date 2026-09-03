/**
 * UMRAIO® — CALL → TEXT AWARENESS (pure core).
 *
 * The text brain must never behave as if the phone call never happened. This
 * turns a real call-session row into bounded prompt guidance. It states only
 * what was actually recorded: nothing is inferred about what was promised.
 */

export type RecentCallRow = {
  call_id?: string | null;
  status?: string | null;
  termination_reason?: string | null;
  answered_at?: string | null;
  ended_at?: string | null;
  received_at?: string | null;
  call_summary?: string | null;
  voice_outcome?: string | null;
} | null;

/** Calls older than this are history, not live continuity. */
export const RECENT_CALL_WINDOW_MS = 6 * 60 * 60 * 1000;

export function isRecentCall(row: RecentCallRow, nowMs: number): boolean {
  if (!row) return false;
  const stamp = row.ended_at ?? row.answered_at ?? row.received_at;
  if (!stamp) return false;
  const at = Date.parse(stamp);
  return Number.isFinite(at) && nowMs - at <= RECENT_CALL_WINDOW_MS;
}

export function recentCallInstruction(row: RecentCallRow, nowMs = Date.now()): string {
  if (!isRecentCall(row, nowMs)) return "";
  const answered = Boolean(row!.answered_at);
  const dropped =
    answered &&
    ["session_timeout", "caller_hangup", "failed", "missed"].includes(
      String(row!.termination_reason ?? ""),
    );
  const lines = [
    answered
      ? "RECENT PHONE CALL: this same customer spoke with you (RAIŌ) on a live WhatsApp call within the last few hours. Continue that conversation — never greet them as a new contact and never deny the call happened."
      : "RECENT PHONE CALL: this customer tried to call within the last few hours and the call did not connect. Acknowledge it briefly and offer to continue here.",
  ];
  if (dropped) {
    lines.push(
      "The call ended before it was properly concluded, so pick up exactly where it stopped and finish what was left open.",
    );
  }
  const summary = (row!.call_summary ?? "").trim();
  if (summary) {
    lines.push("What was discussed on that call (authoritative, do not invent beyond it):", summary);
  }
  return lines.join("\n");
}
