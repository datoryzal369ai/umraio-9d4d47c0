import { supabase } from "@/integrations/supabase/client";

import { recordLeadCreated } from "./conversion/producers";

export type Conversation = {
  id: string;
  agency_id: string;
  lead_id: string | null;
  channel: "whatsapp" | "web" | "manual";
  status: string;
  ai_enabled: boolean;
  last_message_at: string;
  created_at: string;
  conversation_state: string | null;
  intelligence: ConversationIntelligenceSnapshot | null;
};

/** Step 3 — deterministic sales intelligence snapshot persisted per conversation. */
export type ConversationIntelligenceSnapshot = {
  state?: string;
  confidence?: number;
  language?: string;
  language_source?: string;
  style?: string;
  signals?: string[];
  objections?: string[];
  objection_memory?: string[];
  buying_signals?: string[];
  next_best_action?: string;
  missing?: string[];
  quality_score?: number;
  /** Step 3.7 — behavioural sales psychology snapshot (observed behaviour only). */
  behavior?: {
    strategy?: string;
    trust?: { value?: string; confidence?: number };
    hesitation?: { value?: string; confidence?: number };
    price_sensitivity?: { value?: string; confidence?: number };
    decision_readiness?: { value?: string; confidence?: number };
    closing_readiness?: { value?: string; confidence?: number };
    value_dimensions?: string[];
    decision_makers?: string[];
    decision_maker_dependency?: boolean;
    information_load?: string;
    communication_traits?: string[];
  };
  updated_at?: string;
};

export type ConversationWithLead = Conversation & {
  lead: { id: string; full_name: string; phone: string | null; stage: string } | null;
  preview: string;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  agency_id: string;
  sender: "customer" | "ai" | "human";
  body: string;
  created_at: string;
};

const CONV_COLUMNS =
  "id, agency_id, lead_id, channel, status, ai_enabled, last_message_at, created_at, conversation_state, intelligence";

export async function fetchMyAgencyId(): Promise<string | null> {
  const { data, error } = await supabase.from("profiles").select("agency_id").maybeSingle();
  if (error) throw error;
  return (data?.agency_id as string | null) ?? null;
}

export async function fetchConversations(): Promise<ConversationWithLead[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select(`${CONV_COLUMNS}, lead:leads(id, full_name, phone, stage)`)
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  const rows = (data ?? []) as unknown as ConversationWithLead[];
  const ids = rows.map((r) => r.id);
  const previews = new Map<string, string>();
  if (ids.length) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("conversation_id, body, created_at")
      .in("conversation_id", ids)
      .order("created_at", { ascending: false })
      .limit(600);
    for (const m of msgs ?? []) {
      if (!previews.has(m.conversation_id)) previews.set(m.conversation_id, m.body);
    }
  }
  return rows.map((r) => ({ ...r, preview: previews.get(r.id) ?? "No messages yet" }));
}

export async function fetchConversation(id: string): Promise<ConversationWithLead | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(`${CONV_COLUMNS}, lead:leads(id, full_name, phone, stage)`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ConversationWithLead) ?? null;
}

export async function fetchMessages(conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, conversation_id, agency_id, sender, body, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as ChatMessage[];
}

export async function insertMessage(
  conversationId: string,
  agencyId: string,
  sender: ChatMessage["sender"],
  body: string,
): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, agency_id: agencyId, sender, body })
    .select("id, conversation_id, agency_id, sender, body, created_at")
    .single();
  if (error) throw error;
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
  return data as ChatMessage;
}

/**
 * B-3.2 — OWNER AI RESUME CONTROL.
 *
 * Handover state machine: AI_ACTIVE → HUMAN_HANDOFF → OWNER_RESUMED → AI_ACTIVE.
 *
 * Resuming is an explicit owner action. It never replays messages received
 * while the AI was muted: `ai_muted_at` is stamped to *now*, so the J4 filter
 * in `selectCoalescedInbound` treats every muted-era message as history and
 * only NEW inbound messages are ever answered. No catch-up reply is sent here.
 *
 * Tenant scoping is enforced twice: RLS on `conversations`, plus an explicit
 * `agency_id` predicate derived from the caller's own profile.
 */
export async function setAiEnabled(conversationId: string, enabled: boolean) {
  const agencyId = await fetchMyAgencyId();
  if (!agencyId) throw new Error("No agency context for this account");

  const now = new Date().toISOString();
  const patch = enabled
    ? {
        ai_enabled: true,
        // cut-off: muted-era messages are never replayed on resume
        ai_muted_at: now,
        // a crashed/stale claim must never survive a resume
        ai_reply_claimed_at: null,
        ai_reply_due_at: null,
        escalated_at: null,
        status: "open",
      }
    : { ai_enabled: false, ai_muted_at: now };

  const { data, error } = await supabase
    .from("conversations")
    .update(patch)
    .eq("id", conversationId)
    .eq("agency_id", agencyId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Conversation not found for this agency");

  await supabase.from("activity_log").insert({
    agency_id: agencyId,
    actor: "human",
    action: enabled ? "AI Executive resumed by owner" : "AI Executive paused by owner",
    entity: "conversation",
    entity_id: conversationId,
    meta: { ai_enabled: enabled, muted_cutoff_at: now, replayed_muted_messages: false },
  });
}


export async function createConversation(input: {
  agencyId: string;
  fullName: string;
  phone: string | null;
}): Promise<string> {
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({
      agency_id: input.agencyId,
      full_name: input.fullName,
      phone: input.phone,
      source: "whatsapp",
      stage: "new",
      temperature: "warm",
    })
    .select("id")
    .single();
  if (leadError) throw leadError;

  await recordLeadCreated({
    db: supabase,
    agencyId: input.agencyId,
    leadId: lead.id,
    actor: "human",
    source: "whatsapp",
  });

  const { data: conv, error } = await supabase
    .from("conversations")
    .insert({
      agency_id: input.agencyId,
      lead_id: lead.id,
      channel: "whatsapp",
      status: "open",
      ai_enabled: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  return conv.id as string;
}

export function chatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" });
}

export function chatDay(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return "Today";
  return d.toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
}
