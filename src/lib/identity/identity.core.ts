/**
 * Y-6B — user identity & presence foundation (pure logic).
 *
 * No authentication is redesigned here: this module only decides *whether*
 * an identity signal should be written, and how presence is interpreted.
 */

export const LOGIN_EVENT_TYPES = ["login", "logout", "refresh"] as const;
export type LoginEventType = (typeof LOGIN_EVENT_TYPES)[number];

/** Only the three allowed lifecycle signals are ever persisted. */
export function isAllowedLoginEventType(value: unknown): value is LoginEventType {
  return typeof value === "string" && (LOGIN_EVENT_TYPES as readonly string[]).includes(value);
}

/** Presence window: a heartbeat inside 2 minutes means ONLINE. */
export const PRESENCE_ONLINE_WINDOW_MS = 2 * 60 * 1000;
/** Client-side heartbeat cadence (server throttles independently at ~55s). */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export function isOnline(lastSeenAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  const ms = seen.getTime();
  if (!Number.isFinite(ms)) return false;
  return now.getTime() - ms < PRESENCE_ONLINE_WINDOW_MS;
}

export function presenceStatus(
  lastSeenAt: string | Date | null | undefined,
  now: Date = new Date(),
): "online" | "offline" {
  return isOnline(lastSeenAt, now) ? "online" : "offline";
}

/** Client throttle: at most one heartbeat per ~60s. */
export function shouldSendHeartbeat(lastSentAtMs: number | null, nowMs: number): boolean {
  if (lastSentAtMs == null) return true;
  return nowMs - lastSentAtMs >= PRESENCE_HEARTBEAT_INTERVAL_MS;
}

/**
 * Session-scoped dedupe key. React rerenders, route changes and repeated
 * SIGNED_IN callbacks all resolve to the same key, so a session start emits
 * at most one login event.
 */
export function sessionKeyOf(session: {
  access_token?: string | null;
  expires_at?: number | null;
  user?: { id?: string | null } | null;
} | null | undefined): string | null {
  if (!session?.user?.id) return null;
  if (session.expires_at) return `${session.user.id}:${session.expires_at}`;
  const token = session.access_token ?? "";
  // Never store the token itself — only a short non-reversible-enough suffix
  // is avoided too; fall back to the user id alone.
  return token ? `${session.user.id}:session` : `${session.user.id}:session`;
}

export type LoginEventDecision = { record: false } | { record: true; sessionKey: string | null };

/**
 * Decide whether a login-event write is warranted for an auth callback.
 * `seen` is the in-memory set of dedupe keys already emitted this page life.
 */
export function decideLoginEvent(args: {
  eventType: LoginEventType;
  sessionKey: string | null;
  seen: Set<string>;
}): LoginEventDecision {
  const { eventType, sessionKey, seen } = args;
  if (!isAllowedLoginEventType(eventType)) return { record: false };
  // Refresh events are intentionally not written from the client: they would
  // flood the table. Only login/logout are persisted.
  if (eventType === "refresh") return { record: false };
  const key = `${eventType}:${sessionKey ?? "anonymous"}`;
  if (seen.has(key)) return { record: false };
  seen.add(key);
  return { record: true, sessionKey };
}

/**
 * Attribution helper for HUMAN activity_log writes only.
 * AI / customer / system semantics are untouched.
 */
export function humanActor(userId: string | null | undefined): {
  actor: "human";
  actor_user_id: string | null;
} {
  return { actor: "human", actor_user_id: userId ?? null };
}
