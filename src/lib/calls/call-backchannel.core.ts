/** Calling-only presentation and timing; no provider or media changes. */
export function callingSpokenText(text: string): string {
  return text.replace(/\bsemak\b/gi, "periksa");
}

/** Emit only while a substantive answer is still pending, never after abort. */
export async function withCallingBackchannel<T>(args: {
  answer: Promise<T>;
  emit?: (() => void) | undefined;
  /** Second, later utterance for a genuinely slow lookup/reasoning step only. */
  emitLate?: (() => void) | undefined;
  lateDelayMs?: number;
  signal?: AbortSignal | undefined;
  delayMs?: number;
}): Promise<{ answer: T; emitted: boolean; emittedLate: boolean }> {
  let emitted = false;
  let emittedLate = false;
  const timer = args.emit ? setTimeout(() => {
    if (!args.signal?.aborted) {
      args.emit?.();
      emitted = true;
    }
    // 250ms: long enough that a genuinely fast turn answers without an extra
    // utterance, short enough that the caller never hears unexplained silence.
  }, args.delayMs ?? 250) : undefined;
  // Only a REAL wait earns a waiting phrase; a normal-speed turn never reaches it.
  const lateTimer = args.emitLate ? setTimeout(() => {
    if (!args.signal?.aborted) {
      args.emitLate?.();
      emittedLate = true;
    }
  }, args.lateDelayMs ?? 1800) : undefined;
  const cancel = () => { clearTimeout(timer); clearTimeout(lateTimer); };
  args.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const answer = await args.answer;
    args.signal?.throwIfAborted();
    return { answer, emitted, emittedLate };
  } finally {
    cancel();
    args.signal?.removeEventListener("abort", cancel);
  }
}
