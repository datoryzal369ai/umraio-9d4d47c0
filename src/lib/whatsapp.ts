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

/**
 * Signature kept for the existing Settings screen. `agencyId` and `existing`
 * are no longer trusted from the browser — the server derives the agency from
 * the caller's own profile and looks the row up itself.
 */
export async function saveWhatsappConfig(
  _agencyId: string,
  _existing: { id: string; has_access_token: boolean } | null,
  input: WhatsappInput,
): Promise<WhatsappConfig> {
  const data = await saveWhatsappConfigFn({
    data: {
      display_phone_number: input.display_phone_number,
      phone_number_id: input.phone_number_id,
      business_account_id: input.business_account_id,
      access_token: input.access_token,
      auto_reply: input.auto_reply,
    },
  });
  return data as unknown as WhatsappConfig;
}

export async function disconnectWhatsapp(_id: string) {
  // The credential is cleared server-side; it never travels to the browser.
  await disconnectWhatsappFn();
}

