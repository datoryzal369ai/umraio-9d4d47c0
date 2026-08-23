import { supabase } from "@/integrations/supabase/client";

/* ---------------- types ---------------- */

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type DayHours = { open: string; close: string; closed: boolean };
export type BusinessHours = Record<DayKey, DayHours>;

export const DAYS: Array<{ key: DayKey; label: string }> = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

export const DEFAULT_HOURS: BusinessHours = {
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: false },
  sat: { open: "10:00", close: "14:00", closed: false },
  sun: { open: "10:00", close: "14:00", closed: true },
};

export type Agency = {
  id: string;
  name: string;
  country: string;
  timezone: string;
  plan: string;
  logo_url: string | null;
  registration_no: string | null;
  address: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
};

export type AgencySettings = {
  id: string;
  agency_id: string;
  business_hours: BusinessHours;
  ai_name: string;
  ai_personality: string;
  ai_tone: string;
  ai_reply_length: string;
  ai_language: string;
  ai_custom_instructions: string;
  ai_emoji: boolean;
  kb_strict_mode: boolean;
  kb_auto_use: boolean;
  kb_max_articles: number;
  kb_escalate_when_unknown: boolean;
  notify_new_lead: boolean;
  notify_hot_lead: boolean;
  notify_booking: boolean;
  notify_followup_due: boolean;
  notify_daily_summary: boolean;
  notify_email: boolean;
  notify_whatsapp: boolean;
  plan: string;
  plan_status: string;
  seats: number;
  renews_at: string | null;
  voice_persona: string;
  voice_controls: Record<string, number>;
  voice_name: string | null;
};

export type ApiKey = {
  id: string;
  label: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked: boolean;
  created_at: string;
};

export const AI_PERSONALITIES = [
  { value: "professional", label: "Professional", hint: "Corporate, precise, no fluff." },
  { value: "friendly", label: "Friendly", hint: "Warm and conversational." },
  { value: "consultative", label: "Consultative", hint: "Asks deep qualifying questions." },
  { value: "concise", label: "Concise closer", hint: "Short, direct, always proposes next step." },
] as const;

export const AI_TONES = [
  { value: "warm", label: "Warm" },
  { value: "formal", label: "Formal" },
  { value: "enthusiastic", label: "Enthusiastic" },
  { value: "calm", label: "Calm & reassuring" },
] as const;

export const AI_REPLY_LENGTHS = [
  { value: "short", label: "Short (≤45 words)" },
  { value: "balanced", label: "Balanced (≤90 words)" },
  { value: "detailed", label: "Detailed (≤150 words)" },
] as const;

export const AI_LANGUAGES = [
  { value: "auto", label: "Auto — match the customer" },
  { value: "ms", label: "Bahasa Malaysia" },
  { value: "en", label: "English" },
  { value: "mix", label: "Bahasa + English mix" },
  { value: "ar", label: "Arabic" },
] as const;

/**
 * Commercial pricing lives in ONE place — src/lib/billing/pricing.core.ts.
 * Re-exported here only for convenience; no prices are defined in this file.
 */
export { CANONICAL_PLANS, publicPlans, resolveDisplayPlan } from "@/lib/billing/pricing.core";

/* ---------------- agency profile ---------------- */

const AGENCY_COLUMNS =
  "id, name, country, timezone, plan, logo_url, registration_no, address, contact_email, contact_phone, website";

export async function fetchAgency(): Promise<Agency | null> {
  const { data, error } = await supabase.from("agencies").select(AGENCY_COLUMNS).maybeSingle();
  if (error) throw error;
  return (data as Agency | null) ?? null;
}

export async function updateAgency(
  agencyId: string,
  input: Partial<Omit<Agency, "id" | "plan">>,
): Promise<Agency> {
  const { data, error } = await supabase
    .from("agencies")
    .update(input)
    .eq("id", agencyId)
    .select(AGENCY_COLUMNS)
    .single();
  if (error) throw error;
  return data as Agency;
}

export async function uploadAgencyLogo(agencyId: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
  const path = `${agencyId}/logo-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("branding")
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  return path;
}

export async function signedLogoUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from("branding").createSignedUrl(path, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/* ---------------- agency settings ---------------- */

const SETTINGS_COLUMNS =
  "id, agency_id, business_hours, ai_name, ai_personality, ai_tone, ai_reply_length, ai_language, ai_custom_instructions, ai_emoji, kb_strict_mode, kb_auto_use, kb_max_articles, kb_escalate_when_unknown, notify_new_lead, notify_hot_lead, notify_booking, notify_followup_due, notify_daily_summary, notify_email, notify_whatsapp, plan, plan_status, seats, renews_at, voice_persona, voice_controls, voice_name";

export async function fetchSettings(agencyId: string): Promise<AgencySettings> {
  const { data, error } = await supabase
    .from("agency_settings")
    .select(SETTINGS_COLUMNS)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as unknown as AgencySettings;

  const { data: created, error: insertError } = await supabase
    .from("agency_settings")
    .insert({ agency_id: agencyId })
    .select(SETTINGS_COLUMNS)
    .single();
  if (insertError) throw insertError;
  return created as unknown as AgencySettings;
}

export async function updateSettings(
  id: string,
  patch: Partial<Omit<AgencySettings, "id" | "agency_id">>,
): Promise<AgencySettings> {
  const { data, error } = await supabase
    .from("agency_settings")
    .update(patch as never)
    .eq("id", id)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as AgencySettings;
}

/* ---------------- api keys ---------------- */

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, label, key_prefix, last_used_at, revoked, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ApiKey[];
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createApiKey(
  agencyId: string,
  userId: string,
  label: string,
): Promise<{ key: ApiKey; secret: string }> {
  const random = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const secret = `umr_live_${random}`;
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      agency_id: agencyId,
      created_by: userId,
      label: label || "API key",
      key_prefix: secret.slice(0, 16),
      key_hash: await sha256(secret),
    })
    .select("id, label, key_prefix, last_used_at, revoked, created_at")
    .single();
  if (error) throw error;
  return { key: data as ApiKey, secret };
}

export async function revokeApiKey(id: string) {
  const { error } = await supabase.from("api_keys").update({ revoked: true }).eq("id", id);
  if (error) throw error;
}

export async function deleteApiKey(id: string) {
  const { error } = await supabase.from("api_keys").delete().eq("id", id);
  if (error) throw error;
}
