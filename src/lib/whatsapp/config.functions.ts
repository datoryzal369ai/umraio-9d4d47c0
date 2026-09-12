import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * SECURITY: `whatsapp_configs.access_token` is a live Meta credential. The
 * `authenticated` role has no column privilege on it at all (no SELECT and no
 * INSERT/UPDATE), so every write goes through these server functions:
 *
 *  - the caller is authenticated,
 *  - the target agency is derived server-side from the caller's profile,
 *  - only then is the privileged client used to write the credential column,
 *  - the stored token is never projected back to the browser.
 */

export type SaveWhatsappConfigInput = {
  display_phone_number: string | null;
  phone_number_id: string | null;
  business_account_id: string | null;
  /** Write-only. `null`/empty keeps the currently stored credential. */
  access_token: string | null;
  auto_reply: boolean;
};

const CLIENT_COLUMNS =
  "id, agency_id, display_phone_number, phone_number_id, business_account_id, has_access_token, is_connected, auto_reply, last_inbound_at";

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/** Resolve the caller's own agency. Never accepts an agency id from input. */
async function callerAgencyId(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("profiles")
    .select("agency_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const agencyId = (data as { agency_id?: string | null } | null)?.agency_id;
  if (!agencyId) throw new Error("No agency linked to your account.");
  return agencyId;
}

export const saveWhatsappConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SaveWhatsappConfigInput) => ({
    display_phone_number: clean(input?.display_phone_number),
    phone_number_id: clean(input?.phone_number_id),
    business_account_id: clean(input?.business_account_id),
    access_token: clean(input?.access_token),
    auto_reply: Boolean(input?.auto_reply),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const agencyId = await callerAgencyId(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("whatsapp_configs")
      .select("id, has_access_token")
      .eq("agency_id", agencyId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    const hasToken = data.access_token
      ? true
      : Boolean((existing as { has_access_token?: boolean } | null)?.has_access_token);

    const base = {
      display_phone_number: data.display_phone_number,
      phone_number_id: data.phone_number_id,
      business_account_id: data.business_account_id,
      auto_reply: data.auto_reply,
      is_connected: Boolean(data.phone_number_id && hasToken),
    };

    if (existing) {
      // A blank credential field must never wipe the stored token.
      const patch = data.access_token ? { ...base, access_token: data.access_token } : base;
      const { data: updated, error } = await supabaseAdmin
        .from("whatsapp_configs")
        .update(patch)
        .eq("id", (existing as { id: string }).id)
        .eq("agency_id", agencyId)
        .select(CLIENT_COLUMNS)
        .single();
      if (error) throw new Error(error.message);
      return updated;
    }

    const { data: created, error } = await supabaseAdmin
      .from("whatsapp_configs")
      .insert({ ...base, access_token: data.access_token, agency_id: agencyId })
      .select(CLIENT_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    return created;
  });

export const disconnectWhatsappFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const agencyId = await callerAgencyId(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("whatsapp_configs")
      .update({ is_connected: false, access_token: null })
      .eq("agency_id", agencyId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Read the caller's WhatsApp configuration.
 *
 * The `authenticated` role has no table privilege on `whatsapp_configs` at
 * all (the credential column must stay unreachable), so the browser cannot
 * read it directly. This function authenticates the caller, confirms an
 * owner/admin role in their own agency, and returns only the non-secret
 * columns.
 */
export const getWhatsappConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const agencyId = await callerAgencyId(supabase, userId);

    const { data: roles, error: roleError } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("agency_id", agencyId);
    if (roleError) throw new Error(roleError.message);
    const allowed = (roles as { role: string }[] | null ?? []).some(
      (r) => r.role === "owner" || r.role === "admin",
    );
    if (!allowed) throw new Error("Only agency owners or admins can view the WhatsApp connection.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("whatsapp_configs")
      .select(CLIENT_COLUMNS)
      .eq("agency_id", agencyId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  });
