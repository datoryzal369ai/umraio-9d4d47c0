import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Copy, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildInviteUrl,
  canManageInvitations,
  canManageMembers,
  INVITABLE_ROLES,
  roleLabel,
} from "@/lib/team/team.core";
import {
  createAgencyInvitation,
  getAgencyTeam,
  removeAgencyMember,
  revokeAgencyInvitation,
  setAgencyMemberRole,
} from "@/lib/team/team.functions";

export const Route = createFileRoute("/_authenticated/settings/team")({
  head: () => ({
    meta: [
      { title: "Team — UMRAIO" },
      {
        name: "description",
        content:
          "Invite your Umrah agency staff, manage member roles and track pending invitations in one place.",
      },
      { property: "og:title", content: "Team — UMRAIO" },
      {
        property: "og:description",
        content: "Agency members, roles and pending invitations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TeamPage,
});

function TeamPage() {
  const queryClient = useQueryClient();
  const loadTeam = useServerFn(getAgencyTeam);
  const invite = useServerFn(createAgencyInvitation);
  const revoke = useServerFn(revokeAgencyInvitation);
  const changeRole = useServerFn(setAgencyMemberRole);
  const removeMember = useServerFn(removeAgencyMember);

  const { data, isLoading } = useQuery({ queryKey: ["agency-team"], queryFn: () => loadTeam() });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("agent");
  const [freshLink, setFreshLink] = useState<string | null>(null);

  const myRole = data?.myRole ?? null;
  const mayInvite = canManageInvitations(myRole);
  const mayManage = canManageMembers(myRole);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agency-team"] });

  const createInvite = useMutation({
    mutationFn: () => invite({ data: { email, role } }),
    onSuccess: (result) => {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setFreshLink(buildInviteUrl(origin, result.token));
      setEmail("");
      toast.success("Invitation created. Share the link with your team member.");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revokeInvite = useMutation({
    mutationFn: (id: string) => revoke({ data: { id } }),
    onSuccess: () => {
      toast.success("Invitation revoked.");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateRole = useMutation({
    mutationFn: (vars: { userId: string; role: string }) => changeRole({ data: vars }),
    onSuccess: () => {
      toast.success("Role updated.");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const kickMember = useMutation({
    mutationFn: (userId: string) => removeMember({ data: { userId } }),
    onSuccess: () => {
      toast.success("Member removed.");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-foreground">Members</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone who can sign in to this agency workspace.
        </p>

        <ul className="mt-4 divide-y divide-border">
          {(data?.members ?? []).map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{member.name}</p>
                <p className="truncate text-xs text-muted-foreground">{member.email ?? "—"}</p>
              </div>
              <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                {member.roleLabel}
              </Badge>
              {mayManage && member.role !== "owner" && member.role !== "platform_owner" ? (
                <div className="flex items-center gap-2">
                  <Select
                    value={member.role}
                    onValueChange={(value) => updateRole.mutate({ userId: member.id, role: value })}
                  >
                    <SelectTrigger className="h-8 w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INVITABLE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {roleLabel(r)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => kickMember.mutate(member.id)}
                    aria-label={`Remove ${member.name}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {mayInvite ? (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-foreground">Invite a team member</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The invited person signs in with this exact email, then opens the invite link to join.
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="staff@agency.com"
              />
            </div>
            <div className="w-48 space-y-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INVITABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
              <UserPlus className="mr-2 h-4 w-4" />
              Create invite
            </Button>
          </div>

          {freshLink ? (
            <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">
                Copy this link now — it is shown only once.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs">{freshLink}</code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(freshLink);
                    toast.success("Invite link copied.");
                  }}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-foreground">Invitations</h2>
        {(data?.invitations ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No invitations yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {(data?.invitations ?? []).map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {inv.roleLabel} · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </p>
                </div>
                <Badge variant={inv.displayStatus === "pending" ? "secondary" : "outline"}>
                  {inv.displayStatus}
                </Badge>
                {mayInvite && inv.displayStatus === "pending" ? (
                  <Button variant="ghost" size="sm" onClick={() => revokeInvite.mutate(inv.id)}>
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
