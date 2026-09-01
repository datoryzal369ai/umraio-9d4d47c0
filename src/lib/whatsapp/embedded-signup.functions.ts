import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  EMBEDDED_SIGNUP_CONFIG_ID,
  EMBEDDED_SIGNUP_VERSION,
  META_GRAPH_VERSION,
} from "./embedded-signup.core";

export type CompleteEmbeddedSignupInput = {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber?: string | null;
};

/** Public (App ID only) client configuration for the Embedded Signup dialog. */
export const getEmbeddedSignupConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const appId = process.env["META_APP_ID"] ?? "";
    return {
      appId,
      configId: EMBEDDED_SIGNUP_CONFIG_ID,
      version: EMBEDDED_SIGNUP_VERSION,
      graphVersion: META_GRAPH_VERSION,
      configured: Boolean(appId && process.env["META_APP_SECRET"]),
    };
  });

/**
 * Finish Embedded Signup: exchange the code server-to-server, subscribe the app
 * to the WABA, then persist credentials on the caller's own agency row.
 * The access token is never returned to the browser.
 */
export const completeEmbeddedSignup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompleteEmbeddedSignupInput) => {
    const code = input?.code?.trim();
    const wabaId = input?.wabaId?.trim();
    const phoneNumberId = input?.phoneNumberId?.trim();
    if (!code || !wabaId || !phoneNumberId) {
      throw new Error("Incomplete WhatsApp onboarding response from Meta.");
    }
    return {
      code,
      wabaId,
      phoneNumberId,
      displayPhoneNumber: input.displayPhoneNumber?.trim() || null,
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // agency_id is ALWAYS derived server-side from the caller's profile row.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("agency_id")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    const agencyId = (profile as { agency_id?: string | null } | null)?.agency_id;
    if (!agencyId) throw new Error("No agency linked to your account.");

    const { exchangeEmbeddedSignupCode, subscribeAppToWaba, fetchDisplayPhoneNumber } =
      await import("./embedded-signup.server");

    // Any Meta failure throws before a single column is written, so an existing
    // working configuration is left untouched.
    const accessToken = await exchangeEmbeddedSignupCode(data.code);
    await subscribeAppToWaba(data.wabaId, accessToken);
    const displayPhoneNumber =
      data.displayPhoneNumber ?? (await fetchDisplayPhoneNumber(data.phoneNumberId, accessToken));

    // The credential column is service-role-only; the agency was already
    // derived from the caller's own profile above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("whatsapp_configs")
      .select("id, display_phone_number")
      .eq("agency_id", agencyId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    const patch = {
      phone_number_id: data.phoneNumberId,
      business_account_id: data.wabaId,
      access_token: accessToken,
      is_connected: true,
      display_phone_number:
        displayPhoneNumber ??
        (existing as { display_phone_number?: string | null } | null)?.display_phone_number ??
        null,
    };

    if (existing) {
      // auto_reply and every unrelated setting are preserved by not touching them.
      const { error } = await supabaseAdmin
        .from("whatsapp_configs")
        .update(patch)
        .eq("id", (existing as { id: string }).id)
        .eq("agency_id", agencyId);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin
        .from("whatsapp_configs")
        .insert({ ...patch, agency_id: agencyId });
      if (error) throw new Error(error.message);
    }

    return {
      connected: true,
      phoneNumberId: data.phoneNumberId,
      wabaId: data.wabaId,
      displayPhoneNumber: patch.display_phone_number,
    };
  });
