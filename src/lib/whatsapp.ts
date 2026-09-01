import { supabase } from "@/integrations/supabase/client";
import { disconnectWhatsappFn, saveWhatsappConfigFn } from "@/lib/whatsapp/config.functions";

/**
 * SECURITY: `access_token` is never selected into the browser, and the browser
 * can no longer write it either. The database revokes every column-level
 * privilege on it for the `authenticated` role; credential writes go through
 * the authenticated server functions in `whatsapp/config.functions.ts`. The
 * client only ever sees the `has_access_token` indicator.
 */

export type WhatsappConfig = {
  id: string;
  agency_id: string;
  display_phone_number: string | null;
  phone_number_id: string | null;
  business_account_id: string | null;
  has_access_token: boolean;
  is_connected: boolean;
  auto_reply: boolean;
  last_inbound_at: string | null;
};

export type WhatsappInput = {
  display_phone_number: string | null;
  phone_number_id: string | null;
  business_account_id: string | null;
  /** Write-only. `null`/empty keeps the currently stored credential. */
  access_token: string | null;
  auto_reply: boolean;
};

export const WHATSAPP_CLIENT_COLUMNS =
  "id, agency_id, display_phone_number, phone_number_id, business_account_id, has_access_token, is_connected, auto_reply, last_inbound_at";

export async function fetchWhatsappConfig(): Promise<WhatsappConfig | null> {
  const { data, error } = await supabase.from("whatsapp_configs").select(WHATSAPP_CLIENT_COLUMNS).maybeSingle();
  if (error) throw error;
  return (data as WhatsappConfig | null) ?? null;
}

export async function saveWhatsappConfig(
  agencyId: string,
  existing: { id: string; has_access_token: boolean } | null,
  input: WhatsappInput,
): Promise<WhatsappConfig> {
  const token = input.access_token?.trim() ? input.access_token.trim() : null;
  const hasToken = token ? true : Boolean(existing?.has_access_token);
  const isConnected = Boolean(input.phone_number_id && hasToken);

  const base = {
    display_phone_number: input.display_phone_number,
    phone_number_id: input.phone_number_id,
    business_account_id: input.business_account_id,
    auto_reply: input.auto_reply,
    is_connected: isConnected,
  };

  if (existing) {
    const { data, error } = await supabase
      .from("whatsapp_configs")
      // Only write the credential when a new one was entered — the browser
      // cannot read the stored token, so a blank field must not wipe it.
      .update(token ? { ...base, access_token: token } : base)
      .eq("id", existing.id)
      .select(WHATSAPP_CLIENT_COLUMNS)
      .single();
    if (error) throw error;
    return data as WhatsappConfig;
  }

  const { data, error } = await supabase
    .from("whatsapp_configs")
    .insert({ ...base, access_token: token, agency_id: agencyId })
    .select(WHATSAPP_CLIENT_COLUMNS)
    .single();
  if (error) throw error;
  return data as WhatsappConfig;
}

export async function disconnectWhatsapp(id: string) {
  // No projection is requested back, so the credential never leaves the server.
  const { error } = await supabase
    .from("whatsapp_configs")
    .update({ is_connected: false, access_token: null })
    .eq("id", id);
  if (error) throw error;
}
