import { retainBounded, withinCallingBudget, type CallingLifetime } from "./calling-lifetime.server";
import type { CallerAsr } from "./caller-asr.server";

// PostgREST's abortSignal cancels the actual HTTP operation, not just a waiting promise.
export type CallingDb = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type CallingBinding = { agencyId: string; sessionId: string; callId: string; gatewaySessionId: string };
export type CallerTurn = { id: string; agency_id: string; session_id: string; sequence: number; generation: string;
  transcript: string; received_at: string; asr_completed_at: string; persisted_at: string;
  language: string | null; duration_ms: number | null; confidence: "unknown"; channel: "whatsapp_calling" };
export type TurnLease = { state: "admitted" | "duplicate" | "pending" | "terminal" | "legacy";
  revision: number; generation: string; turn: CallerTurn | null; can_respond: boolean };

export const bindingArgs = (b: CallingBinding) => ({ p_agency: b.agencyId, p_session: b.sessionId,
  p_call: b.callId, p_gateway: b.gatewaySessionId });

export async function callingRpc<T>(db: CallingDb, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { data, error } = await db.rpc(name, args).abortSignal(signal);
  if (error || data == null) throw new Error(`calling_storage_${name}_${error?.code ?? "unavailable"}`);
  return data as T;
}

/** Admission and persistence are independent of the assistant response signal. */
export function retainCallerTurn(args: {
  db: CallingDb; binding: CallingBinding; sequence: number; greeting: boolean; receivedAt: string;
  lifetime: CallingLifetime; asr: (signal: AbortSignal) => Promise<CallerAsr>;
  durationMs: number; requestDigest: string;
  timings?: Record<string, number>;
}): Promise<TurnLease> {
  return retainBounded(args.lifetime, 25_000, async lifetimeSignal => {
    const base = { ...bindingArgs(args.binding), p_sequence: args.sequence };
    const lease = await withinCallingBudget(lifetimeSignal, 3_000, signal => callingRpc<TurnLease>(args.db, "calling_bridge_begin", {
      ...base, p_greeting: args.greeting, p_received_at: args.receivedAt, p_request_digest: args.requestDigest,
    }, signal));
    if (lease.state !== "admitted" || args.greeting) return lease;
    args.timings && (args.timings["asr_start"] = Date.now());
    const asr = await withinCallingBudget(lifetimeSignal, 16_000, args.asr);
    const asrCompletedAt = new Date().toISOString();
    args.timings && (args.timings["asr_end"] = Date.now());
    if (!asr.text.trim()) throw new Error("calling_asr_empty_transcript");
    args.timings && (args.timings["persist_start"] = Date.now());
    const result = await withinCallingBudget(lifetimeSignal, 5_000, signal => callingRpc<TurnLease>(args.db, "calling_bridge_persist_caller", {
      ...base, p_generation: lease.generation, p_transcript: asr.text, p_asr_completed_at: asrCompletedAt,
      p_language: asr.language, p_duration_ms: asr.durationSeconds === null ? args.durationMs || null : Math.round(asr.durationSeconds * 1000),
    }, signal));
    args.timings && (args.timings["persist_end"] = Date.now());
    return result;
  });
}
