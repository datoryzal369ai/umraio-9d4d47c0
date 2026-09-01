import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { CheckCircle2, ShieldAlert } from "lucide-react";

import { BrandLogo } from "@/components/brand/BrandLogo";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { INVITATION_INVALID_MESSAGE } from "@/lib/team/team.core";
import { acceptAgencyInvitation } from "@/lib/team/team.functions";

export const Route = createFileRoute("/join/$token")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Join your agency — UMRAIO" },
      { name: "robots", content: "noindex, nofollow" },
      {
        name: "description",
        content: "Accept your UMRAIO agency invitation and join your team workspace.",
      },
      { property: "og:title", content: "Join your agency — UMRAIO" },
      {
        property: "og:description",
        content: "Accept your UMRAIO agency invitation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: JoinPage,
});

function JoinPage() {
  const { token } = Route.useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const accept = useServerFn(acceptAgencyInvitation);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const looksValid = /^[0-9a-f]{64}$/i.test(token);

  const join = useMutation({
    // The token is the only thing the client controls. Agency and role are
    // resolved entirely by the SECURITY DEFINER database function.
    mutationFn: () => accept({ data: { token } }),
    onSuccess: (result) => {
      if (result.ok) {
        setDone(true);
        return;
      }
      setFailed(result.message ?? INVITATION_INVALID_MESSAGE);
    },
    onError: () => setFailed(INVITATION_INVALID_MESSAGE),
  });

  useEffect(() => {
    if (!loading && user && looksValid && !done && !failed && !join.isPending) {
      join.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, looksValid]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6">
      <BrandLogo />

      <section className="rounded-xl border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold text-foreground">Agency invitation</h1>

        {!looksValid ? (
          <InvalidState message={INVITATION_INVALID_MESSAGE} />
        ) : loading ? (
          <p className="mt-3 text-sm text-muted-foreground">Checking your invitation…</p>
        ) : !user ? (
          <div className="mt-3 space-y-4">
            <p className="text-sm text-muted-foreground">
              Sign in with the exact email address your agency invited, then this page will complete
              the join automatically.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/auth" search={{ mode: "login", redirect: `/join/${token}` }}>
                  Sign in
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/auth" search={{ mode: "register", redirect: `/join/${token}` }}>
                  Create account
                </Link>
              </Button>
            </div>
          </div>
        ) : done ? (
          <div className="mt-3 space-y-4">
            <p className="flex items-start gap-2 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              You have joined your agency workspace. Your role was set by your agency owner.
            </p>
            <Button onClick={() => navigate({ to: "/dashboard", replace: true })}>
              Go to workspace
            </Button>
          </div>
        ) : failed ? (
          <InvalidState message={failed} />
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Joining your agency…</p>
        )}
      </section>
    </main>
  );
}

/**
 * One generic outcome for invalid, expired, revoked, already-used, wrong-email
 * and unknown tokens: the page never reveals whether an invitation exists.
 */
function InvalidState({ message }: { message: string }) {
  return (
    <div className="mt-3 space-y-4">
      <p className="flex items-start gap-2 text-sm text-foreground">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        {message}
      </p>
      <Button asChild variant="outline">
        <Link to="/">Back to UMRAIO</Link>
      </Button>
    </div>
  );
}
