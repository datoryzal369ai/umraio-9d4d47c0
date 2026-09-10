/** Calling request work retained by the existing Cloudflare request context. */
export type CallingLifetime = { retain: (work: Promise<unknown>) => void };

export function callingLifetime(request: Request): CallingLifetime {
  const req = request as Request & { waitUntil?: (work: Promise<unknown>) => void };
  if (typeof req.waitUntil !== "function") throw new Error("calling_durable_lifetime_unavailable");
  return { retain: work => req.waitUntil!(work) };
}

/** No response signal: completed caller input and dispatched receipts have their own bounded owner. */
export function retainBounded<T>(lifetime: CallingLifetime, milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!(milliseconds > 0 && milliseconds <= 25_000)) throw new Error("calling_lifetime_budget_invalid");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Calling persistence deadline", "TimeoutError")), milliseconds);
  const task = Promise.resolve().then(() => work(controller.signal)).finally(() => clearTimeout(timer));
  // Register immediately, before any ASR/network await or response cancellation.
  // The work must pass this signal to every I/O operation; a promise race alone is not cancellation.
  try { lifetime.retain(task.catch(() => undefined)); }
  catch (error) { controller.abort(error); clearTimeout(timer); throw new Error("calling_durable_lifetime_unavailable"); }
  return task;
}

export async function withinCallingBudget<T>(parent: AbortSignal, milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const forward = () => controller.abort(parent.reason);
  parent.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Calling operation deadline", "TimeoutError")), milliseconds);
  try { return await work(controller.signal); }
  finally { clearTimeout(timer); parent.removeEventListener("abort", forward); }
}
