import { supabase } from "@/integrations/supabase/client";

export const LEAD_STAGES = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "booked",
  "completed",
  "lost",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const STAGE_LABELS: Record<LeadStage, string> = {
  new: "New Lead",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Quoted",
  negotiation: "Negotiation",
  booked: "Booked",
  completed: "Completed",
  lost: "Lost",
};


export const LEAD_TEMPERATURES = ["hot", "warm", "cold"] as const;
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number];

export const LEAD_SOURCES = ["whatsapp", "web", "manual", "referral", "walk-in"] as const;

export type Lead = {
  id: string;
  agency_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  source: string;
  stage: LeadStage;
  temperature: LeadTemperature;
  tags: string[];
  score: number;
  budget_myr: number | null;
  pax: number;
  preferred_month: string | null;
  preferred_language: string;
  detected_language: string | null;
  conversational_style: string | null;
  last_contact_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LeadNote = {
  id: string;
  lead_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
};

export type LeadInput = {
  full_name: string;
  phone: string | null;
  email: string | null;
  source: string;
  stage: LeadStage;
  temperature: LeadTemperature;
  tags: string[];
  budget_myr: number | null;
  pax: number;
  preferred_month: string | null;
  preferred_language?: string;
};

const LEAD_COLUMNS =
  "id, agency_id, full_name, phone, email, source, stage, temperature, tags, score, budget_myr, pax, preferred_month, preferred_language, detected_language, conversational_style, last_contact_at, created_at, updated_at";

export async function fetchLeads(): Promise<Lead[]> {
  const { data, error } = await supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as Lead[];
}

export async function fetchLead(id: string): Promise<Lead | null> {
  const { data, error } = await supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as Lead | null) ?? null;
}

export async function currentAgencyId(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.agency_id) throw new Error("No agency linked to your account.");
  return data.agency_id;
}

export async function createLead(agencyId: string, input: LeadInput): Promise<Lead> {
  const { data, error } = await supabase
    .from("leads")
    .insert({ ...input, agency_id: agencyId })
    .select(LEAD_COLUMNS)
    .single();
  if (error) throw error;
  await logActivity(agencyId, "Lead created", data.id, input.full_name);
  return data as Lead;
}

export async function updateLead(id: string, input: Partial<LeadInput>): Promise<Lead> {
  const { data, error } = await supabase
    .from("leads")
    .update(input)
    .eq("id", id)
    .select(LEAD_COLUMNS)
    .single();
  if (error) throw error;
  await logActivity(data.agency_id, "Lead updated", data.id, data.full_name);
  return data as Lead;
}

export async function updateLeadStage(lead: Lead, stage: LeadStage): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ stage, last_contact_at: new Date().toISOString() })
    .eq("id", lead.id);
  if (error) throw error;
  await logActivity(
    lead.agency_id,
    "Pipeline stage changed",
    lead.id,
    `${STAGE_LABELS[lead.stage] ?? lead.stage} → ${STAGE_LABELS[stage]}`,
  );
}

export async function deleteLead(id: string): Promise<void> {
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) throw error;
}

export async function fetchLeadNotes(leadId: string): Promise<LeadNote[]> {
  const { data, error } = await supabase
    .from("lead_notes")
    .select("id, lead_id, author_id, body, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as LeadNote[];
}

export async function addLeadNote(args: {
  agencyId: string;
  leadId: string;
  authorId: string;
  body: string;
}): Promise<void> {
  const { error } = await supabase.from("lead_notes").insert({
    agency_id: args.agencyId,
    lead_id: args.leadId,
    author_id: args.authorId,
    body: args.body,
  });
  if (error) throw error;
  await logActivity(args.agencyId, "Note added", args.leadId, args.body.slice(0, 80));
}

export async function deleteLeadNote(id: string): Promise<void> {
  const { error } = await supabase.from("lead_notes").delete().eq("id", id);
  if (error) throw error;
}

export type Reminder = {
  id: string;
  title: string;
  run_at: string;
  status: string;
  channel: string;
  lead_id: string | null;
};

export async function fetchLeadReminders(leadId: string): Promise<Reminder[]> {
  const { data, error } = await supabase
    .from("followup_jobs")
    .select("id, title, run_at, status, channel, lead_id")
    .eq("lead_id", leadId)
    .order("run_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Reminder[];
}

export async function createReminder(args: {
  agencyId: string;
  leadId: string;
  title: string;
  runAt: string;
  channel: string;
}): Promise<void> {
  const { error } = await supabase.from("followup_jobs").insert({
    agency_id: args.agencyId,
    lead_id: args.leadId,
    title: args.title,
    run_at: args.runAt,
    channel: args.channel as "whatsapp" | "web" | "manual",
  });
  if (error) throw error;
  await logActivity(args.agencyId, "Follow-up scheduled", args.leadId, args.title);
}

export async function completeReminder(id: string): Promise<void> {
  const { error } = await supabase.from("followup_jobs").update({ status: "sent" }).eq("id", id);
  if (error) throw error;
}

export async function deleteReminder(id: string): Promise<void> {
  const { error } = await supabase.from("followup_jobs").delete().eq("id", id);
  if (error) throw error;
}

export type Activity = {
  id: string;
  actor: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

export async function fetchLeadActivity(leadId: string): Promise<Activity[]> {
  const { data, error } = await supabase
    .from("activity_log")
    .select("id, actor, action, entity, entity_id, meta, created_at")
    .eq("entity_id", leadId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as Activity[];
}

async function logActivity(
  agencyId: string,
  action: string,
  leadId: string,
  detail?: string,
): Promise<void> {
  await supabase.from("activity_log").insert({
    agency_id: agencyId,
    actor: "human",
    action,
    entity: "lead",
    entity_id: leadId,
    meta: detail ? { detail } : {},
  });
}

export function formatMyr(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, "minute"],
    [3_600_000, "hour"],
    [86_400_000, "day"],
    [604_800_000, "week"],
    [2_592_000_000, "month"],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60_000) return "just now";
  for (let i = 0; i < units.length; i += 1) {
    const [ms, unit] = units[i]!;
    const next = units[i + 1]?.[0] ?? Infinity;
    if (abs < next) return rtf.format(-Math.round(diff / ms), unit);
  }
  return new Date(iso).toLocaleDateString();
}
