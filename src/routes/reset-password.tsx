import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { BrandLogo } from "@/components/brand/BrandLogo";
import { SubmitButton } from "@/components/app/SubmitButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useCopy } from "@/lib/i18n/dict";
import { accountCopy } from "@/lib/i18n/app/account.i18n";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Set a new password — UMRAIO" },
      { name: "robots", content: "noindex, nofollow" },
      {
        name: "description",
        content: "Choose a new password for your UMRAIO Autonomous AI Business Executive account.",
      },
      { property: "og:title", content: "Set a new password — UMRAIO" },
      { property: "og:description", content: "Securely reset your UMRAIO account password." },
    ],
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const navigate = useNavigate();
  const copy = useCopy(accountCopy).resetPassword;
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const hash = window.location.hash;
    const isRecovery = hash.includes("type=recovery");

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (isRecovery && session)) setReady(true);
    });

    supabase.auth.getSession().then(({ data: sessionData }) => {
      if (sessionData.session) setReady(true);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (ready) passwordRef.current?.focus();
  }, [ready]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = z
      .object({
        password: z.string().min(8, copy.passwordMin).max(72),
        confirm: z.string(),
      })
      .refine((values) => values.password === values.confirm, {
        message: copy.passwordsDoNotMatch,
      })
      .safeParse({ password: form.get("password"), confirm: form.get("confirm") });

    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? copy.invalidPassword);
      return;
    }

    setPending(true);
    const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
    setPending(false);

    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(copy.passwordUpdated);
    navigate({ to: "/dashboard", replace: true });
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-aurora px-5 py-12">
      <BrandLogo showTagline className="mb-8" />
      <div className="panel w-full max-w-md p-7 shadow-elevated sm:p-9">
        <ShieldCheck className="size-8 text-primary" />
        <h1 className="mt-5 text-2xl font-bold">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {ready ? copy.readyDescription : copy.notReadyDescription}
        </p>

        {ready ? (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label>{copy.newPassword}</Label>
              <Input
                ref={passwordRef}
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <div className="space-y-2">
              <Label>{copy.confirmPassword}</Label>
              <Input
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <SubmitButton pending={pending} className="w-full">
              {copy.updatePassword}
            </SubmitButton>
          </form>
        ) : (
          <Button
            variant="outline"
            className="mt-6 w-full"
            onClick={() => navigate({ to: "/auth", search: { mode: "forgot" } })}
          >
            {copy.requestNewLink}
          </Button>
        )}
      </div>
    </div>
  );
}
