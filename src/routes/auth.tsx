import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { MailCheck } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { BrandLogo } from "@/components/brand/BrandLogo";
import { SubmitButton } from "@/components/app/SubmitButton";
import { LanguageSelector } from "@/components/app/LanguageSelector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/hooks/useAuth";
import { useCopy } from "@/lib/i18n/dict";
import { accountCopy } from "@/lib/i18n/app/account.i18n";

type Mode = "login" | "register" | "forgot";

const searchSchema = z.object({
  mode: z.enum(["login", "register", "forgot"]).optional().default("login"),
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Sign in — UMRAIO® AI Autonomous Business Executive" },
      { name: "robots", content: "noindex, follow" },
      {
        name: "description",
        content:
          "Sign in or create your UMRAIO® agency account to manage the AI Autonomous Business Executive for licensed Umrah agencies.",
      },
      { property: "og:title", content: "Sign in — UMRAIO® AI Autonomous Business Executive" },
      {
        property: "og:description",
        content: "Access your UMRAIO® agency workspace.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://umraio.com/auth" },
      { name: "twitter:title", content: "Sign in — UMRAIO® AI Autonomous Business Executive" },
      { name: "twitter:description", content: "Access your UMRAIO® agency workspace." },
    ],
    links: [{ rel: "canonical", href: "https://umraio.com/auth" }],
  }),
  component: AuthPage,
});

function safeRedirect(value: string | undefined) {
  if (!value) return "/dashboard";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const copy = useCopy(accountCopy).auth;
  const [mode, setMode] = useState<Mode>(search.mode ?? "login");
  const [pending, setPending] = useState(false);
  const [emailSent, setEmailSent] = useState<null | "verify" | "reset">(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const destination = safeRedirect(search.redirect);

  const emailSchema = z.string().trim().email(copy.invalidEmail).max(255);
  const passwordSchema = z.string().min(8, copy.passwordMin).max(72, copy.passwordMax);

  useEffect(() => {
    if (!loading && user) {
      navigate({ to: destination, replace: true });
    }
  }, [loading, user, destination, navigate]);

  useEffect(() => {
    emailRef.current?.focus();
  }, [mode]);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = z
      .object({ email: emailSchema, password: z.string().min(1, copy.enterPassword) })
      .safeParse({ email: form.get("email"), password: form.get("password") });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? copy.invalidDetails);
      return;
    }

    setPending(true);
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    setPending(false);

    if (error) {
      toast.error(
        error.message === "Email not confirmed" ? copy.emailNotConfirmed : copy.invalidLogin,
      );
      return;
    }
    toast.success(copy.welcomeBack);
    navigate({ to: destination, replace: true });
  }

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = z
      .object({
        fullName: z.string().trim().min(2, copy.enterFullName).max(100),
        agencyName: z.string().trim().min(2, copy.enterAgencyName).max(120),
        email: emailSchema,
        password: passwordSchema,
      })
      .safeParse({
        fullName: form.get("fullName"),
        agencyName: form.get("agencyName"),
        email: form.get("email"),
        password: form.get("password"),
      });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? copy.invalidDetails);
      return;
    }

    setPending(true);
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: { full_name: parsed.data.fullName, agency_name: parsed.data.agencyName },
      },
    });
    setPending(false);

    if (error) {
      toast.error(
        error.message.toLowerCase().includes("already") ? copy.alreadyRegistered : error.message,
      );
      return;
    }

    if (data.session) {
      navigate({ to: destination, replace: true });
      return;
    }
    setEmailSent("verify");
  }

  async function handleForgot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = emailSchema.safeParse(form.get("email"));
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? copy.enterValidEmail);
      return;
    }

    setPending(true);
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);

    if (error) {
      toast.error(error.message);
      return;
    }
    setEmailSent("reset");
  }

  async function handleGoogle() {
    setPending(true);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      setPending(false);
      toast.error(copy.googleFailed);
      return;
    }
    if (result.redirected) return;
    navigate({ to: destination, replace: true });
  }

  if (emailSent) {
    return (
      <AuthLayout>
        <div className="text-center">
          <MailCheck className="mx-auto size-9 text-primary" />
          <h1 className="mt-5 text-2xl font-bold">{copy.checkInbox}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {emailSent === "verify" ? copy.verifyBody : copy.resetBody}
          </p>
          <Button
            variant="outline"
            className="mt-6 w-full"
            onClick={() => {
              setEmailSent(null);
              setMode("login");
            }}
          >
            {copy.backToSignIn}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="text-2xl font-bold">
        {mode === "register"
          ? copy.createAccountTitle
          : mode === "forgot"
            ? copy.resetPasswordTitle
            : copy.signInTitle}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {mode === "forgot" ? copy.resetPasswordDescription : copy.workspaceDescription}
      </p>

      {mode !== "forgot" ? (
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as Mode)}
          className="mt-6 w-full"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">{copy.signInTab}</TabsTrigger>
            <TabsTrigger value="register">{copy.registerTab}</TabsTrigger>
          </TabsList>

          <TabsContent value="login" className="mt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <Field label={copy.workEmail}>
                <Input ref={emailRef} name="email" type="email" autoComplete="email" required />
              </Field>
              <Field label={copy.password}>
                <Input name="password" type="password" autoComplete="current-password" required />
              </Field>
              <button
                type="button"
                onClick={() => setMode("forgot")}
                className="text-xs text-primary hover:underline"
              >
                {copy.forgotPassword}
              </button>
              <SubmitButton pending={pending}>{copy.signIn}</SubmitButton>
            </form>
          </TabsContent>

          <TabsContent value="register" className="mt-6">
            <form onSubmit={handleRegister} className="space-y-4">
              <Field label={copy.fullName}>
                <Input name="fullName" autoComplete="name" required maxLength={100} />
              </Field>
              <Field label={copy.agencyName}>
                <Input name="agencyName" autoComplete="organization" required maxLength={120} />
              </Field>
              <Field label={copy.workEmail}>
                <Input name="email" type="email" autoComplete="email" required />
              </Field>
              <Field label={copy.password}>
                <Input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </Field>
              <SubmitButton pending={pending}>{copy.createAccount}</SubmitButton>
            </form>
          </TabsContent>
        </Tabs>
      ) : (
        <form onSubmit={handleForgot} className="mt-6 space-y-4">
          <Field label={copy.workEmail}>
            <Input ref={emailRef} name="email" type="email" autoComplete="email" required />
          </Field>
          <SubmitButton pending={pending}>{copy.sendResetLink}</SubmitButton>
          <Button type="button" variant="ghost" className="w-full" onClick={() => setMode("login")}>
            {copy.backToSignIn}
          </Button>
        </form>
      )}

      {mode !== "forgot" ? (
        <>
          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {copy.or}
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={handleGoogle}
          >
            {copy.continueWithGoogle}
          </Button>
        </>
      ) : null}

      <p className="mt-8 text-center text-xs text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          {copy.backToUmraio}
        </Link>
      </p>
    </AuthLayout>
  );
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-aurora px-5 py-12">
      <div className="mb-4 flex w-full max-w-md justify-end">
        <LanguageSelector />
      </div>
      <BrandLogo showTagline className="mb-8" />
      <div className="panel w-full max-w-md p-7 shadow-elevated sm:p-9">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
