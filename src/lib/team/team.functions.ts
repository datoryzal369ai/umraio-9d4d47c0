/**
 * UMRAIO® — Agency Team / Invitation V1 server functions.
 *
 * Authorization is always enforced by the database: every mutation goes
 * through a SECURITY DEFINER function that re-derives the caller's agency
 * from `profiles.agency_id` and their role from `user_roles`. The client can
 * never supply an agency id or elevate a role.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import {
  buildTeamMembers,
  checkInviteAcceptRate,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_INVALID_MESSAGE,
  invitationExpiry,
  isInvitableRole,
  isValidEmail,
  normalizeEmail,
  shapeInvitations,
  type InvitationRow,
  type TeamMemberRow,
  type TeamRoleRow,
} from "./team.core";

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Members, roles and invitations for the caller's own agency (RLS scoped). */
export const getAgencyTeam = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: profile } = await supabase
      .from("profiles")
      .select("agency_id")
      .eq("id", userId)
      .maybeSingle();

    const agencyId = (profile as { agency_id: string | null } | null)?.agency_id ?? null;
    if (!agencyId) {
      return { agencyId: null, myRole: null, members: [], invitations: [] };
    }

    const [profilesRes, rolesRes, invitesRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, email, last_seen_at")
        .eq("agency_id", agencyId)
        .limit(200),
      supabase.from("user_roles").select("user_id, role").eq("agency_id", agencyId).limit(400),
      supabase
        .from("agency_invitations")
        .select("id, email, role, status, expires_at, created_at, accepted_at")
        .eq("agency_id", agencyId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    const roles = (rolesRes.data ?? []) as TeamRoleRow[];
    const myRole =
      roles.find((r) => r.user_id === userId && r.role === "owner")?.role ??
      roles.find((r) => r.user_id === userId)?.role ??
      null;

    return {
      agencyId,
      myRole,
      members: buildTeamMembers((profilesRes.data ?? []) as TeamMemberRow[], roles),
      invitations: shapeInvitations((invitesRes.data ?? []) as InvitationRow[]),
    };
  });

/** Owner/admin only (enforced in SQL). Returns the raw token exactly once. */
export const createAgencyInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { email: string; role: string }) => {
    const email = normalizeEmail(String(input?.email ?? ""));
    if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
    if (!isInvitableRole(input?.role)) {
      throw new Error("Only admin, agent or Islamic approver can be invited.");
    }
    return { email, role: input.role };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);

    const { data: id, error } = await supabase.rpc("create_agency_invitation", {
      p_email: data.email,
      p_role: data.role,
      p_token_hash: tokenHash,
      p_expires_at: invitationExpiry(),
    });

    if (error) {
      throw new Error(
        error.message?.includes("forbidden")
          ? "Only the agency owner or an admin can invite members."
          : "Could not create the invitation.",
      );
    }

    return { id: id as string, token, email: data.email, role: data.role };
  });

export const revokeAgencyInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!isUuid(input?.id)) throw new Error("Invalid invitation.");
    return { id: input.id };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("revoke_agency_invitation", { p_id: data.id });
    if (error) throw new Error("Could not revoke the invitation.");
    return { ok: true };
  });

/**
 * Acceptance. The invited email is compared against the verified JWT email
 * inside the database function; the client controls nothing but the token.
 */
export const acceptAgencyInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string }) => {
    const token = String(input?.token ?? "").trim();
    if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error(INVITATION_INVALID_MESSAGE);
    return { token };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    if (!checkInviteAcceptRate(userId).allowed) {
      return { ok: false as const, message: INVITATION_INVALID_MESSAGE };
    }

    const tokenHash = await hashInvitationToken(data.token);
    const { data: result, error } = await supabase.rpc("accept_agency_invitation", {
      p_token_hash: tokenHash,
    });

    const ok = !error && (result as { ok?: boolean } | null)?.ok === true;
    if (!ok) return { ok: false as const, message: INVITATION_INVALID_MESSAGE };
    return { ok: true as const };
  });

/** Owner-only role change (enforced in SQL). */
export const setAgencyMemberRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; role: string }) => {
    if (!isUuid(input?.userId)) throw new Error("Invalid member.");
    if (!isInvitableRole(input?.role)) throw new Error("That role cannot be assigned.");
    return { userId: input.userId, role: input.role };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("set_agency_member_role", {
      p_user_id: data.userId,
      p_role: data.role,
    });
    if (error) throw new Error("Only the agency owner can change member roles.");
    return { ok: true };
  });

/** Owner-only member removal (enforced in SQL). */
export const removeAgencyMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string }) => {
    if (!isUuid(input?.userId)) throw new Error("Invalid member.");
    return { userId: input.userId };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("remove_agency_member", {
      p_user_id: data.userId,
    });
    if (error) throw new Error("Only the agency owner can remove members.");
    return { ok: true };
  });
