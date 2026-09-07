/**
 * UMRAIO® — ONE CUSTOMER, ONE RELATIONSHIP MEMORY.
 *
 * A live call must not behave like a new anonymous conversation when the same
 * customer already spoke to RAIŌ through WhatsApp text or voice notes. This
 * module resolves the caller to the SAME lead / conversation / sales state the
 * text channel uses, and returns a bounded HOT-context block for the voice
 * prompt.
 *
 * It never invents memory: when nothing is stored, it returns an empty context
 * and RAIŌ behaves as a genuine first contact.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

type Db = { from: (table: string) => any };

export type CallerContext = {
  leadId: string | null;
  conversationId: string | null;
  knownName: string | null;
  /** Bounded, human-readable facts injected into the voice system prompt. */
  promptLines: string[];
  facts: Record<string, unknown>;
};

export const EMPTY_CALLER_CONTEXT: CallerContext = {
  leadId: null,
  conversationId: null,
  knownName: null,
  promptLines: [],
  facts: {},
};

/** Digits only; matching is done on the last 9 digits to survive +60 / 0 forms. */
function phoneTail(phone: string): string | null {
  const digits = phone.replace(/\D+/g, "");
  return digits.length >= 8 ? digits.slice(-9) : null;
}

function clip(text: string, max = 160): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * HOT CONTEXT hydration. Bounded by design: the newest handful of messages,
 * the lead's sales state and the live quotation — never a full transcript.
 */
export async function hydrateCallerContext(
  db: Db,
  args: { agencyId: string; callerPhone: string },
): Promise<CallerContext> {
  const tail = phoneTail(args.callerPhone ?? "");
  if (!tail) return EMPTY_CALLER_CONTEXT;

  const { data: leads } = await db
    .from("leads")
    .select(
      "id, full_name, phone, stage, temperature, pax, preferred_month, package_interest, budget_myr, total_budget_myr, preferred_language, conversational_style, traveller_needs, tags",
    )
    .eq("agency_id", args.agencyId)
    .ilike("phone", `%${tail}`)
    .order("last_contact_at", { ascending: false, nullsFirst: false })
    .limit(1);
  const lead = (Array.isArray(leads) ? leads[0] : null) ?? null;
  if (!lead) return EMPTY_CALLER_CONTEXT;

  const [{ data: conversations }, { data: quotations }] = await Promise.all([
    db
      .from("conversations")
      .select("id, channel, conversation_state, last_message_at")
      .eq("agency_id", args.agencyId)
      .eq("lead_id", lead.id)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1),
    db
      .from("quotations")
      .select("quotation_number, status, total, deposit_amount, number_of_pilgrims, created_at")
      .eq("agency_id", args.agencyId)
      .eq("lead_id", lead.id)
      .in("status", ["ready", "sent", "viewed", "discussing", "accepted", "deposit_pending"])
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  const conversation = (Array.isArray(conversations) ? conversations[0] : null) ?? null;
  const quotation = (Array.isArray(quotations) ? quotations[0] : null) ?? null;

  let recent: Array<{ sender: string; body: string; modality?: string | null }> = [];
  if (conversation?.id) {
    const { data: messages } = await db
      .from("messages")
      .select("sender, body, modality, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(10);
    recent = Array.isArray(messages) ? [...messages].reverse() : [];
  }

  const promptLines: string[] = [];
  const name = (lead.full_name as string | null)?.trim() || null;
  promptLines.push(
    `This caller is an EXISTING customer${name ? ` (${name})` : ""}. Do not ask for information already known below.`,
  );
  const known: string[] = [];
  if (lead.stage) known.push(`sales stage: ${lead.stage}`);
  if (lead.package_interest) known.push(`package interest: ${lead.package_interest}`);
  if (lead.pax) known.push(`travellers: ${lead.pax}`);
  if (lead.preferred_month) known.push(`preferred month: ${lead.preferred_month}`);
  if (lead.total_budget_myr ?? lead.budget_myr)
    known.push(`budget: RM${lead.total_budget_myr ?? lead.budget_myr}`);
  if (Array.isArray(lead.traveller_needs) && lead.traveller_needs.length)
    known.push(`needs: ${lead.traveller_needs.join(", ")}`);
  if (known.length) promptLines.push(`Known relationship facts — ${known.join("; ")}.`);

  if (quotation) {
    promptLines.push(
      `A quotation already exists: ${quotation.quotation_number ?? "current"} (status ${quotation.status}, total RM${quotation.total}). Refer to it naturally; do not re-quote by voice.`,
    );
  }

  if (recent.length) {
    const lines = recent.map((m) => {
      const who = m.sender === "customer" ? "Customer" : "RAIŌ";
      const via = m.modality && m.modality !== "text" ? ` (${m.modality})` : "";
      return `${who}${via}: ${clip(String(m.body ?? ""))}`;
    });
    promptLines.push(
      "Recent WhatsApp conversation with this same customer (text and voice notes) — continue it naturally, never restart it:",
      ...lines,
    );
  }

  return {
    leadId: lead.id as string,
    conversationId: (conversation?.id as string | null) ?? null,
    knownName: name,
    promptLines,
    facts: {
      known_customer: true,
      stage: lead.stage ?? null,
      package_interest: lead.package_interest ?? null,
      pax: lead.pax ?? null,
      quotation_status: quotation?.status ?? null,
      recent_messages: recent.length,
    },
  };
}

/**
 * CALL → TEXT continuity. The structured call summary is written back into the
 * SAME WhatsApp thread so the next text or voice note already knows what was
 * discussed on the phone. Best-effort: a failure here never fails the call —
 * but it is never silent either: every database error is logged (code only)
 * and returned as an enumerated outcome the caller can persist.
 *
 * INCREMENTAL by design: a dropped call must not lose the conversation. The
 * summary is refreshed after every substantive turn, keyed by the call id, so
 * exactly ONE memory row exists per call and it is always current — even when
 * the caller hangs up mid-sentence and the end-of-call path never runs.
 *
 * Schema contract (widening migration 2026-09): messages.modality accepts
 * `call_summary` and messages.delivery_status accepts `internal`. These rows
 * are internal notes — never sent to the customer, rendered as plain text in
 * the CRM timeline and excluded from outbound-text metrics.
 */
export function callMemoryMarker(callId: string): string {
  return `[call ${callId}]`;
}

export const CALL_MEMORY_MODALITY = "call_summary";
export const CALL_MEMORY_DELIVERY_STATUS = "internal";

export type CallMemoryOutcome =
  | "skipped_no_conversation"
  | "skipped_empty_summary"
  | "updated"
  | "inserted"
  | "lookup_failed"
  | "update_failed"
  | "insert_failed"
  | "threw";

type DbError = { code?: string | null; message?: string | null } | null | undefined;

function logDbError(stage: string, callId: string | null | undefined, error: DbError): void {
  // Code + stage only: never the row body (it contains the customer's words).
  console.error(
    `[calls] call_memory_write_failed stage=${stage} call_id=${callId ?? "unknown"} code=${error?.code ?? "unknown"}`,
  );
}

export async function persistCallMemory(
  db: Db,
  args: {
    agencyId: string;
    conversationId: string | null;
    summary: string;
    /** When present, the summary row for this call is UPDATED, never duplicated. */
    callId?: string | null;
  },
): Promise<CallMemoryOutcome> {
  if (!args.conversationId) return "skipped_no_conversation";
  if (!args.summary.trim()) return "skipped_empty_summary";
  const marker = args.callId ? callMemoryMarker(args.callId) : null;
  const body = marker ? `${args.summary.trim()}\n${marker}` : args.summary.trim();
  try {
    if (marker) {
      const lookup = (await db
        .from("messages")
        .select("id")
        .eq("conversation_id", args.conversationId)
        .eq("modality", CALL_MEMORY_MODALITY)
        .ilike("body", `%${marker}%`)
        .limit(1)
        .maybeSingle()) as { data?: { id?: string } | null; error?: DbError } | null;
      if (lookup?.error) {
        logDbError("lookup", args.callId, lookup.error);
        return "lookup_failed";
      }
      const existingId = lookup?.data?.id;
      if (existingId) {
        const updated = (await db.from("messages").update({ body }).eq("id", existingId)) as {
          error?: DbError;
        } | null;
        if (updated?.error) {
          logDbError("update", args.callId, updated.error);
          return "update_failed";
        }
        return "updated";
      }
    }
    const inserted = (await db.from("messages").insert({
      agency_id: args.agencyId,
      conversation_id: args.conversationId,
      sender: "ai",
      body,
      modality: CALL_MEMORY_MODALITY,
      delivery_status: CALL_MEMORY_DELIVERY_STATUS,
    })) as { error?: DbError } | null;
    if (inserted?.error) {
      logDbError("insert", args.callId, inserted.error);
      return "insert_failed";
    }
    return "inserted";
  } catch (error) {
    console.error(
      `[calls] call_memory_write_failed stage=exception call_id=${args.callId ?? "unknown"} error=${(error as Error)?.name ?? "Error"}`,
    );
    return "threw";
  }
}

/**
 * Called when Meta reports the call ended (including a caller hang-up mid
 * conversation). Flushes whatever RAIŌ already knows into the WhatsApp thread
 * so the text brain can continue the SAME conversation immediately.
 * Returns the enumerated outcome so the call path can record it; never throws.
 */
export async function finalizeCallMemory(
  db: Db,
  args: { callId: string },
): Promise<CallMemoryOutcome> {
  try {
    const { data: session, error } = (await db
      .from("whatsapp_call_sessions")
      .select("agency_id, conversation_id, call_summary, call_id")
      .eq("call_id", args.callId)
      .maybeSingle()) as { data?: Record<string, unknown> | null; error?: DbError };
    if (error) {
      logDbError("session_lookup", args.callId, error);
      return "lookup_failed";
    }
    if (!session?.["conversation_id"]) return "skipped_no_conversation";
    if (!session?.["call_summary"]) return "skipped_empty_summary";
    const outcome = await persistCallMemory(db, {
      agencyId: String(session["agency_id"]),
      conversationId: String(session["conversation_id"]),
      summary: String(session["call_summary"]),
      callId: String(session["call_id"] ?? args.callId),
    });
    console.log(`[calls] call_memory_finalized call_id=${args.callId} outcome=${outcome}`);
    return outcome;
  } catch (error) {
    console.error(
      `[calls] call_memory_write_failed stage=finalize call_id=${args.callId} error=${(error as Error)?.name ?? "Error"}`,
    );
    return "threw";
  }
}

