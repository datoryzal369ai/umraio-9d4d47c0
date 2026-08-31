/**
 * UMRAIO® — P1-2 public quotation abuse protection.
 *
 * Sliding-window counters keyed by a hashed IP (never a raw address).
 * Deliberately fails open: availability of a customer's quotation link is
 * more important than a perfect counter.
 */

export const PUBLIC_QUOTATION_LIMITS = {
  read: 60,
  respond: 10,
} as const;

export type PublicQuotationAction = keyof typeof PUBLIC_QUOTATION_LIMITS;

export const PUBLIC_QUOTATION_WINDOW_MS = 60 * 60_000;

const buckets = new Map<string, number[]>();

/** Test-only helper so counters never leak across specs. */
export function resetPublicQuotationRateLimit(): void {
  buckets.clear();
}

export function checkPublicQuotationRate(
  action: PublicQuotationAction,
  ipHash: string,
  now: number = Date.now(),
): { allowed: boolean; remaining: number } {
  try {
    if (!ipHash) return { allowed: true, remaining: PUBLIC_QUOTATION_LIMITS[action] };
    const key = `${action}:${ipHash}`;
    const cutoff = now - PUBLIC_QUOTATION_WINDOW_MS;
    const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
    const limit = PUBLIC_QUOTATION_LIMITS[action];
    if (hits.length >= limit) {
      buckets.set(key, hits);
      return { allowed: false, remaining: 0 };
    }
    hits.push(now);
    buckets.set(key, hits);
    if (buckets.size > 5_000) {
      // Bounded memory: drop the oldest key when the map grows unexpectedly.
      const first = buckets.keys().next();
      if (!first.done && first.value !== key) buckets.delete(first.value);
    }
    return { allowed: true, remaining: limit - hits.length };
  } catch {
    // Fail open.
    return { allowed: true, remaining: PUBLIC_QUOTATION_LIMITS[action] };
  }
}

export const PUBLIC_QUOTATION_RATE_MESSAGE =
  "Too many requests. Please try again shortly.";

/** Single generic message: never reveals whether a token exists or its state. */
export const PUBLIC_QUOTATION_INVALID_MESSAGE = "Quotation link is no longer valid.";
