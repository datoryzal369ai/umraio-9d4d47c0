import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { isAllowedLoginEventType, type LoginEventType } from "./identity.core";

/**
 * Y-6B — records a login lifecycle event.
 *
 * The user id comes from the verified session only; the agency is resolved
 * server-side from the profile. The client cannot supply either. Writes go
 * through the service role because `login_events` grants no INSERT to
 * authenticated users.
 */
export const recordLoginEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { eventType: LoginEventType; sessionKey?: string | null }) => {
    if (!isAllowedLoginEventType(input?.eventType)) {
      throw new Error("Unsupported login event type");
    }
    const sessionKey =
      typeof input.sessionKey === "string" && input.sessionKey.length <= 200
        ? input.sessionKey
        : null;
    return { eventType: input.eventType, sessionKey };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: profile } = await supabase
      .from("profiles")
      .select("agency_id")
      .eq("id", userId)
      .maybeSingle();

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin.from("login_events").insert({
      user_id: userId,
      agency_id: profile?.agency_id ?? null,
      event_type: data.eventType,
      session_key: data.sessionKey,
    });

    // Duplicate protection: the partial unique index rejects a second
    // login/logout for the same session. That is a success, not a failure.
    if (error && error.code !== "23505") {
      return { recorded: false as const, reason: error.message };
    }

    return { recorded: !error };
  });

/**
 * Y-6B — presence heartbeat. Updates only the caller's own
 * `profiles.last_seen_at`, throttled to roughly once per 60 seconds inside
 * the database function. No user id or agency id is accepted from the client.
 */
export const recordPresenceHeartbeat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await (supabase as unknown as {
      rpc: (fn: string) => Promise<{ data: string | null; error: { message: string } | null }>;
    }).rpc("touch_presence");
    if (error) return { lastSeenAt: null as string | null, ok: false as const };
    return { lastSeenAt: data, ok: true as const };
  });
