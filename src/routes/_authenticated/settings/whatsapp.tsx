import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Check, Copy, MessageCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useCopy } from "@/lib/i18n/dict";
import { settingsCopy } from "@/lib/i18n/app/settings.i18n";
import { currentAgencyId } from "@/lib/leads";
import {
  disconnectWhatsapp,
  fetchWhatsappConfig,
  saveWhatsappConfig,
  type WhatsappInput,
} from "@/lib/whatsapp";

export const Route = createFileRoute("/_authenticated/settings/whatsapp")({
  head: () => ({
    meta: [
      { title: "WhatsApp Integration — UMRAIO Autonomous AI Business Executive" },
      {
        name: "description",
        content:
          "Connect your WhatsApp Business number so the UMRAIO Autonomous AI Business Executive answers Umrah enquiries automatically.",
      },
      { property: "og:title", content: "WhatsApp Integration — UMRAIO" },
      {
        property: "og:description",
        content: "Connect WhatsApp Cloud API and let the AI reply, qualify and follow up.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WhatsappSettings,
});

function CopyField({
  label,
  value,
  copyAriaLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyAriaLabel: (label: string) => string;
  copiedLabel: (label: string) => string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={copyAriaLabel(label)}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            toast.success(copiedLabel(label));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

function WhatsappSettings() {
  const { user } = useAuth();
  const copy = useCopy(settingsCopy).whatsapp;
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useQuery({
    queryKey: ["whatsapp-config"],
    queryFn: fetchWhatsappConfig,
  });

  const [form, setForm] = useState<WhatsappInput>({
    display_phone_number: "",
    phone_number_id: "",
    business_account_id: "",
    access_token: "",
    auto_reply: true,
  });

  useEffect(() => {
    if (!config) return;
    setForm({
      display_phone_number: config.display_phone_number ?? "",
      phone_number_id: config.phone_number_id ?? "",
      business_account_id: config.business_account_id ?? "",
      // The stored credential is never sent to the browser.
      access_token: "",
      auto_reply: config.auto_reply,
    });
  }, [config]);

  const save = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error(copy.toasts.notSignedIn);
      const agencyId = await currentAgencyId(user.id);
      return saveWhatsappConfig(
        agencyId,
        config ? { id: config.id, has_access_token: config.has_access_token } : null,
        {
          display_phone_number: form.display_phone_number || null,
          phone_number_id: form.phone_number_id || null,
          business_account_id: form.business_account_id || null,
          access_token: form.access_token || null,
          auto_reply: form.auto_reply,
        },
      );
    },
    onSuccess: () => {
      toast.success(copy.toasts.saved);
      queryClient.invalidateQueries({ queryKey: ["whatsapp-config"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      if (!config) return;
      await disconnectWhatsapp(config.id);
    },
    onSuccess: () => {
      toast.success(copy.toasts.disconnected);
      queryClient.invalidateQueries({ queryKey: ["whatsapp-config"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const webhookUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/public/whatsapp` : "";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader
        eyebrow={copy.header.eyebrow}
        title={copy.header.title}
        description={copy.header.description}
      />

      {isLoading ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : (
        <>
          <section className="panel space-y-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="rounded-xl border border-border/60 bg-surface p-2.5">
                  <MessageCircle className="size-4 text-primary" />
                </div>
                <div>
                  <h2 className="font-display text-base font-semibold">{copy.status.title}</h2>
                  <p className="text-xs text-muted-foreground">
                    {config?.last_inbound_at
                      ? copy.status.lastInbound.replace(
                          "{date}",
                          new Date(config.last_inbound_at).toLocaleString("en-MY"),
                        )
                      : copy.status.noInbound}
                  </p>
                </div>
              </div>
              <Badge
                className={
                  config?.is_connected
                    ? "bg-success/15 text-success"
                    : "bg-muted text-muted-foreground"
                }
              >
                {config?.is_connected ? copy.status.connected : copy.status.notConnected}
              </Badge>
            </div>
          </section>

          <section className="panel space-y-4 p-5">
            <h2 className="font-display text-base font-semibold">{copy.credentials.title}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="display">{copy.credentials.displayNumber}</Label>
                <Input
                  id="display"
                  placeholder="+60 12-345 6789"
                  value={form.display_phone_number ?? ""}
                  onChange={(e) => setForm({ ...form, display_phone_number: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pnid">{copy.credentials.phoneNumberId}</Label>
                <Input
                  id="pnid"
                  placeholder="1234567890"
                  value={form.phone_number_id ?? ""}
                  onChange={(e) => setForm({ ...form, phone_number_id: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="waba">{copy.credentials.businessAccountId}</Label>
                <Input
                  id="waba"
                  placeholder="0987654321"
                  value={form.business_account_id ?? ""}
                  onChange={(e) => setForm({ ...form, business_account_id: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="token">{copy.credentials.accessToken}</Label>
                <Input
                  id="token"
                  type="password"
                  autoComplete="off"
                  placeholder={config?.has_access_token ? copy.credentials.tokenPlaceholderStored : copy.credentials.tokenPlaceholderNew}
                  value={form.access_token ?? ""}
                  onChange={(e) => setForm({ ...form, access_token: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {config?.has_access_token
                    ? copy.credentials.tokenStoredNote
                    : copy.credentials.tokenNotStoredNote}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
              <div>
                <p className="text-sm font-medium">{copy.credentials.autoReply}</p>
                <p className="text-xs text-muted-foreground">
                  {copy.credentials.autoReplyDescription}
                </p>
              </div>
              <Switch
                checked={form.auto_reply}
                onCheckedChange={(checked) => setForm({ ...form, auto_reply: checked })}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? copy.credentials.saving : copy.credentials.save}
              </Button>
              {config?.is_connected ? (
                <Button
                  variant="outline"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  {copy.credentials.disconnect}
                </Button>
              ) : null}
            </div>
          </section>

          <section className="panel space-y-4 p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" />
              <h2 className="font-display text-base font-semibold">{copy.webhook.title}</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              {copy.webhook.instructions.split("{field}")[0]}
              <span className="font-mono">{copy.webhook.field}</span>
              {copy.webhook.instructions.split("{field}")[1]}
            </p>
            <CopyField
              label={copy.webhook.callbackUrl}
              value={webhookUrl}
              copyAriaLabel={(label) => copy.webhook.copyAria.replace("{label}", label)}
              copiedLabel={(label) => copy.toasts.copied.replace("{label}", label)}
            />
            <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm">
              {copy.webhook.configured}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
