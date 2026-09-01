/**
 * Server-trusted role read for navigation shaping only.
 *
 * RLS ("Users can view own roles") restricts this query to the caller's own
 * rows, so a client cannot fabricate a role. Every privileged action stays
 * guarded server-side; this hook only decides what is worth showing.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { effectiveAgencyRole, isPlatformOwner } from "@/lib/team/team.core";

export function useMyRoles() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["my-roles", user?.id ?? null],
    enabled: Boolean(user?.id),
    staleTime: 60_000,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user!.id);
      return (rows ?? []).map((r) => String(r.role));
    },
  });

  const roles = data ?? [];
  return {
    roles,
    role: effectiveAgencyRole(roles),
    isPlatformOwner: isPlatformOwner(roles),
    loading: isLoading,
  };
}
