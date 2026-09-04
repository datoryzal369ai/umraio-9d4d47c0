import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import {
  buildAgencySummaries,
  buildChannelActivity,
  buildAgencyUsers,
  buildPlatformStats,
  isUuid,
  lastActivityByAgency,
  maskSessionKey,
  HQ_SECURITY_CHECKS,
  type HqAgencyRow,
  type HqEntitlementRow,
  type HqActivityRow,
  type HqLoginEventRow,
  type HqProfileRow,
  type HqRoleRow,
  type HqMessageRow,
  type HqConversationRow,
  type HqLeadRow,
  type HqCallSessionRow,
} from "./hq.core";

/**
 * Platform-owner authorization. The role is read through the caller's own
 * session (RLS: "Users can view own roles"), never from client input.
 */
async function assertPlatformOwner(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "platform_owner")
    .limit(1);

  if (error || !data || data.length === 0) {
    throw new Error("Forbidden: platform owner access required");
  }
}

/** All agencies with user counts, owner and plan. Platform owner only. */
export const getHqOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertPlatformOwner(supabase as never, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [agenciesRes, profilesRes, rolesRes, entRes] = await Promise.all([
      supabaseAdmin
        .from("agencies")
        .select("id, name, plan, created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      supabaseAdmin
        .from("profiles")
        .select("id, agency_id, full_name, email, last_seen_at")
        .limit(2000),
      supabaseAdmin.from("user_roles").select("user_id, agency_id, role").limit(4000),
      supabaseAdmin
        .from("agency_entitlements")
        .select("agency_id, effective_plan, source")
        .limit(500),
    ]);

    const agencies = buildAgencySummaries(
      (agenciesRes.data ?? []) as HqAgencyRow[],
      (profilesRes.data ?? []) as HqProfileRow[],
      (rolesRes.data ?? []) as HqRoleRow[],
      (entRes.data ?? []) as HqEntitlementRow[],
    );

    return { agencies };
  });

/** Users + recent login activity for one agency. Platform owner only. */
export const getHqAgencyDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { agencyId: string }) => {
    if (!isUuid(input?.agencyId)) throw new Error("Invalid agency selector");
    return { agencyId: input.agencyId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Authorization never depends on the requested agency id.
    await assertPlatformOwner(supabase as never, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [profilesRes, rolesRes, eventsRes] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, agency_id, full_name, email, last_seen_at")
        .eq("agency_id", data.agencyId)
        .limit(500),
      supabaseAdmin
        .from("user_roles")
        .select("user_id, agency_id, role")
        .eq("agency_id", data.agencyId)
        .limit(1000),
      supabaseAdmin
        .from("login_events")
        .select("id, user_id, event_type, occurred_at")
        .eq("agency_id", data.agencyId)
        .order("occurred_at", { ascending: false })
        .limit(50),
    ]);

    const profiles = (profilesRes.data ?? []) as HqProfileRow[];
    const users = buildAgencyUsers(profiles, (rolesRes.data ?? []) as HqRoleRow[]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    const activity = (eventsRes.data ?? []).map((e) => ({
      id: e.id as string,
      userId: e.user_id as string,
      userName: nameById.get(e.user_id as string) ?? "(unknown user)",
      eventType: e.event_type as string,
      occurredAt: e.occurred_at as string,
    }));

    return { users, activity };
  });

/**
 * Founder HQ Control Center — platform-wide read-only snapshot.
 * Platform owner only; authorization is server-side and never derived
 * from client input.
 */
export const getHqPlatform = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertPlatformOwner(supabase as never, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [agenciesRes, profilesRes, rolesRes, entRes, loginsRes, activityRes] = await Promise.all([
      supabaseAdmin
        .from("agencies")
        .select("id, name, plan, created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      supabaseAdmin
        .from("profiles")
        .select("id, agency_id, full_name, email, last_seen_at")
        .limit(2000),
      supabaseAdmin.from("user_roles").select("user_id, agency_id, role").limit(4000),
      supabaseAdmin
        .from("agency_entitlements")
        .select("agency_id, effective_plan, source")
        .limit(500),
      supabaseAdmin
        .from("login_events")
        .select("id, user_id, agency_id, event_type, session_key, occurred_at")
        .order("occurred_at", { ascending: false })
        .limit(200),
      supabaseAdmin
        .from("activity_log")
        .select("id, agency_id, actor, actor_user_id, action, entity, entity_id, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    const profiles = (profilesRes.data ?? []) as HqProfileRow[];
    const roles = (rolesRes.data ?? []) as HqRoleRow[];
    const logins = (loginsRes.data ?? []) as HqLoginEventRow[];

    const agencies = buildAgencySummaries(
      (agenciesRes.data ?? []) as HqAgencyRow[],
      profiles,
      roles,
      (entRes.data ?? []) as HqEntitlementRow[],
    );

    const agencyNameById = new Map(agencies.map((a) => [a.id, a.name]));
    const lastActivity = lastActivityByAgency(profiles, logins);
    const users = buildAgencyUsers(profiles, roles).map((u) => {
      const agencyId = profiles.find((p) => p.id === u.id)?.agency_id ?? null;
      return {
        ...u,
        agencyId,
        agencyName: agencyId ? (agencyNameById.get(agencyId) ?? "—") : "—",
      };
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    return {
      stats: buildPlatformStats(agencies, profiles, logins),
      agencies: agencies.map((a) => ({ ...a, lastActivityAt: lastActivity[a.id] ?? null })),
      users,
      logins: logins.map((e) => ({
        id: e.id,
        userName: userById.get(e.user_id)?.name ?? "(unknown user)",
        userEmail: userById.get(e.user_id)?.email ?? null,
        agencyName: e.agency_id ? (agencyNameById.get(e.agency_id) ?? "—") : "—",
        eventType: e.event_type,
        sessionKey: maskSessionKey(e.session_key),
        occurredAt: e.occurred_at,
      })),
      activity: ((activityRes.data ?? []) as HqActivityRow[]).map((a) => ({
        id: a.id,
        createdAt: a.created_at,
        userName: a.actor_user_id ? (userById.get(a.actor_user_id)?.name ?? a.actor) : a.actor,
        agencyName: agencyNameById.get(a.agency_id) ?? "—",
        action: a.action,
        entity: a.entity,
        entityId: a.entity_id,
      })),
      security: HQ_SECURITY_CHECKS,
    };
  });

/**
 * Founder HQ Channel Activity v1 — read-only unified feed across WhatsApp
 * text, voice notes and live calls. Consumes existing production telemetry
 * only; nothing here writes. Platform owner only.
 */
export const getHqChannelActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertPlatformOwner(supabase as never, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [messagesRes, callsRes, agenciesRes] = await Promise.all([
      supabaseAdmin
        .from("messages")
        .select("id, agency_id, conversation_id, sender, modality, delivery_status, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
      supabaseAdmin
        .from("whatsapp_call_sessions")
        .select(
          "id, agency_id, lead_id, caller_phone, direction, status, termination_reason, received_at, answered_at, ended_at, turn_count",
        )
        .order("received_at", { ascending: false })
        .limit(100),
      supabaseAdmin.from("agencies").select("id, name").limit(500),
    ]);

    const messages = (messagesRes.data ?? []) as HqMessageRow[];
    const calls = (callsRes.data ?? []) as HqCallSessionRow[];

    const conversationIds = [...new Set(messages.map((m) => m.conversation_id))];
    const convRes = conversationIds.length
      ? await supabaseAdmin
          .from("conversations")
          .select("id, lead_id, channel, human_attention_required")
          .in("id", conversationIds)
      : { data: [] as HqConversationRow[] };

    const conversations = (convRes.data ?? []) as HqConversationRow[];
    const leadIds = [
      ...new Set(
        [...conversations.map((c) => c.lead_id), ...calls.map((c) => c.lead_id)].filter(
          Boolean,
        ) as string[],
      ),
    ];
    const leadsRes = leadIds.length
      ? await supabaseAdmin
          .from("leads")
          .select("id, full_name, phone, do_not_contact")
          .in("id", leadIds)
      : { data: [] as HqLeadRow[] };

    const agencyNames = new Map(
      ((agenciesRes.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]),
    );

    return {
      items: buildChannelActivity({
        messages,
        conversations,
        calls,
        leads: (leadsRes.data ?? []) as HqLeadRow[],
        agencyNames,
        limit: 200,
      }),
    };
  });
