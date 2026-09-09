/** Calling-only presentation and timing; no provider or media changes. */
export function callingSpokenText(text: string): string {
  return text.replace(/\bsemak\b/gi, "periksa");
}

/** Emit only while a substantive answer is still pending, never after abort. */
export async function withCallingBackchannel<T>(args: {
  answer: Promise<T>;
  emit?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
  delayMs?: number;
}): Promise<{ answer: T; emitted: boolean }> {
  let emitted = false;
  const timer = args.emit ? setTimeout(() => {
    if (!args.signal?.aborted) {
      args.emit?.();
      emitted = true;
    }
  }, args.delayMs ?? 350) : undefined;
  const cancel = () => clearTimeout(timer);
  args.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const answer = await args.answer;
    args.signal?.throwIfAborted();
    return { answer, emitted };
  } finally {
    cancel();
    args.signal?.removeEventListener("abort", cancel);
  }
}
