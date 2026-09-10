import type { WhatsappSendOutcome } from "@/lib/whatsapp-send.server";
import { bindingArgs, callingRpc, type CallingBinding, type CallingDb } from "./caller-turn-ledger.server";
import { boundedCallingDb } from "./calling-db-lifetime.server";
import { retainBounded, type CallingLifetime } from "./calling-lifetime.server";
import { deliverCallingQuotation, type CallingQuotationResult, type QuotationReceipt } from "./call-quotation.server";
import type { CognitiveDecision, CognitivePacket } from "./cognitive-bridge.contract";

/** Execution owns a finite lifetime; cancellation of speech never abandons an irreversible receipt. */
export function executeCallingDecision(args: {
  db: CallingDb; binding: CallingBinding; packet: CognitivePacket; decision: CognitiveDecision;
  lifetime: CallingLifetime; responseSignal: AbortSignal; timings: Record<string, number>;
}): Promise<CallingQuotationResult> {
  const action = args.packet.available_actions.find(a => a.tool === args.decision.allowed_tool
    && a.quotation_id === args.decision.requested_action?.quotation_id);
  if (!args.decision.action_required || !action) return Promise.resolve({ ok: false, reason: "action_not_authorized" });
  return retainBounded(args.lifetime, 25_000, async owner => {
    const deadline = Date.now() + 25_000;
    const db = boundedCallingDb(args.db, owner);
    const base = { ...bindingArgs(args.binding), p_sequence: args.packet.identity.sequence,
      p_generation: args.packet.identity.generation, p_revision: args.packet.identity.input_revision, p_quotation: action.quotation_id };
    const rpc = (operation: string, result: Record<string, unknown> = {}) => callingRpc<{
      ok: boolean; reason?: string; outcome?: string; receipt?: QuotationReceipt;
    }>(db, "calling_bridge_action", { ...base, p_operation: operation, p_result: result }, owner);
    args.responseSignal.throwIfAborted();
    const claim = await rpc("claim");
    if (!claim.ok) {
      if (claim.reason === "already_claimed") {
        const reconciled = await rpc("reconcile");
        if (reconciled.ok && reconciled.outcome === "verified_success" && reconciled.receipt) return { ok: true, receipt: reconciled.receipt };
      }
      return { ok: false, reason: claim.reason ?? "already_claimed", outcome: "outcome_unknown" };
    }
    let result: CallingQuotationResult;
    let dispatched = false;
    args.timings["tool_start"] = Date.now();
    try {
      result = await deliverCallingQuotation({ db, agencyId: args.binding.agencyId, callId: args.binding.callId,
        sequence: args.packet.identity.sequence, transcript: args.packet.current_call.current_caller.transcript,
        leadId: action.lead_id, conversationId: action.conversation_id, quotationId: action.quotation_id,
        signal: args.responseSignal,
        execution: { signal: owner, timeoutMs: 12_000, beforeDispatch: async () => {
          args.responseSignal.throwIfAborted();
          // Leave room for the existing receipt writes and the final durable action outcome.
          if (deadline - Date.now() < 18_000) throw new DOMException("Insufficient Calling receipt budget", "TimeoutError");
          const fence = await rpc("dispatch");
          if (!fence.ok) throw new DOMException("Calling turn superseded", "AbortError");
          args.responseSignal.throwIfAborted();
          dispatched = true;
          args.timings["dispatch_start"] = Date.now();
        } },
      });
    } catch {
      result = { ok: false, reason: dispatched ? "dispatch_unverified" : "dispatch_not_started",
        outcome: dispatched ? "outcome_unknown" : "cancelled", dispatched };
    }
    args.timings["tool_end"] = Date.now();
    const persisted = await rpc("finish", result.ok ? { outcome: "verified_success", receipt: result.receipt }
      : { outcome: result.outcome ?? (dispatched ? "outcome_unknown" : "cancelled"), cause: result.reason, dispatched: result.dispatched ?? dispatched,
        ...(result.providerEvidence ? { receipt: result.providerEvidence } : {}) });
    if (!persisted.ok || persisted.outcome !== "verified_success") return { ok: false,
      reason: result.ok ? "receipt_not_verified" : result.reason, outcome: persisted.ok ? persisted.outcome as WhatsappSendOutcome : "outcome_unknown" };
    args.timings["receipt_persisted"] = Date.now();
    return result;
  });
}
