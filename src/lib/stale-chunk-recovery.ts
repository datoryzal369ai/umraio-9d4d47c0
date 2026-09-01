/**
 * Recovers from "Failed to fetch dynamically imported module" errors.
 *
 * After a new deploy, an already-open tab still holds the previous build's
 * HTML, which references hashed chunk filenames that no longer exist on the
 * CDN. Any lazy route import then rejects and the page goes blank.
 *
 * The only correct recovery is a hard reload so the browser fetches the new
 * index HTML. We guard with sessionStorage so a genuinely broken chunk cannot
 * cause an infinite reload loop.
 */

const RELOAD_FLAG = "umraio:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 30_000;

const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /'text\/html' is not a valid javascript mime type/i,
];

export function isStaleChunkError(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === "string"
        ? reason
        : "";
  if (!message) return false;
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message));
}

function reloadOnce(): void {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_FLAG) ?? "0");
    if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return;
    window.sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode): fall through and reload once.
  }
  window.location.reload();
}

export function installStaleChunkRecovery(): () => void {
  if (typeof window === "undefined") return () => {};

  const onPreloadError = (event: Event) => {
    event.preventDefault();
    reloadOnce();
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isStaleChunkError(event.reason)) return;
    event.preventDefault();
    reloadOnce();
  };
  const onError = (event: ErrorEvent) => {
    if (!isStaleChunkError(event.error ?? event.message)) return;
    reloadOnce();
  };

  window.addEventListener("vite:preloadError", onPreloadError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError);

  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError);
  };
}
