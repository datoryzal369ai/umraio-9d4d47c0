import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Bot, BookOpen, Languages } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { settingsCopy } from "@/lib/i18n/app/settings.i18n";
import { useCopy } from "@/lib/i18n/dict";
import {
  AI_LANGUAGES,
  AI_PERSONALITIES,
  AI_REPLY_LENGTHS,
  AI_TONES,
  fetchAgency,
  fetchSettings,
  updateSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/ai")({
  head: () => ({
    meta: [
      { title: "AI Personality & Knowledge Settings — UMRAIO" },
      {
        name: "description",
        content:
          "Tune the UMRAIO Autonomous AI Business Executive: personality, tone, reply length, language and how it uses your knowledge base.",
      },
      { property: "og:title", content: "AI Personality & Knowledge — UMRAIO" },
      {
        property: "og:description",
        content: "Personality, tone, language and knowledge base behaviour for your AI.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AiSettingsPage,
});

function Panel({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Bot;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel space-y-4 p-5">
      <header className="flex items-start gap-3">
        <div className="rounded-xl border border-border/60 bg-surface p-2.5">
          <Icon className="size-4 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </div>
  );
}

function AiSettingsPage() {
  const copy = useCopy(settingsCopy).ai;
  const queryClient = useQueryClient();
  const { data: agency } = useQuery({ queryKey: ["agency"], queryFn: fetchAgency });
  const { data: settings, isLoading } = useQuery({
    queryKey: ["agency-settings", agency?.id],
    queryFn: () => fetchSettings(agency!.id),
    enabled: Boolean(agency?.id),
  });

  const [form, setForm] = useState({
    ai_name: "UMRAIO",
    ai_personality: "professional",
    ai_tone: "warm",
    ai_reply_length: "balanced",
    ai_language: "auto",
    ai_custom_instructions: "",
    ai_emoji: true,
    kb_strict_mode: true,
    kb_auto_use: true,
    kb_max_articles: 4,
    kb_escalate_when_unknown: true,
  });

  useEffect(() => {
    if (!settings) return;
    setForm({
      ai_name: settings.ai_name,
      ai_personality: settings.ai_personality,
      ai_tone: settings.ai_tone,
      ai_reply_length: settings.ai_reply_length,
      ai_language: settings.ai_language,
      ai_custom_instructions: settings.ai_custom_instructions,
      ai_emoji: settings.ai_emoji,
      kb_strict_mode: settings.kb_strict_mode,
      kb_auto_use: settings.kb_auto_use,
      kb_max_articles: settings.kb_max_articles,
      kb_escalate_when_unknown: settings.kb_escalate_when_unknown,
    });
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      if (!settings) throw new Error(copy.toasts.settingsNotLoaded);
      return updateSettings(settings.id, {
        ...form,
        ai_name: form.ai_name.trim().slice(0, 60) || "UMRAIO",
        ai_custom_instructions: form.ai_custom_instructions.slice(0, 2000),
      });
    },
    onSuccess: () => {
      toast.success(copy.toasts.saved);
      queryClient.invalidateQueries({ queryKey: ["agency-settings"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading || !settings) return <Skeleton className="h-[520px] rounded-2xl" />;

  return (
    <div className="space-y-6">
      <Panel
        icon={Bot}
        title={copy.personality.title}
        description={copy.personality.description}
      >
        <div className="space-y-1.5">
          <Label htmlFor="ai-name">{copy.personality.assistantName}</Label>
          <Input
            id="ai-name"
            maxLength={60}
            value={form.ai_name}
            onChange={(e) => setForm({ ...form, ai_name: e.target.value })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {AI_PERSONALITIES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setForm({ ...form, ai_personality: option.value })}
              className={cn(
                "rounded-xl border p-4 text-left transition-colors",
                form.ai_personality === option.value
                  ? "border-primary bg-primary/10"
                  : "border-border bg-surface hover:border-primary/40",
              )}
            >
              <p className="text-sm font-semibold">{option.label}</p>
              <p className="text-xs text-muted-foreground">{option.hint}</p>
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{copy.personality.tone}</Label>
            <Select
              value={form.ai_tone}
              onValueChange={(value) => setForm({ ...form, ai_tone: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_TONES.map((tone) => (
                  <SelectItem key={tone.value} value={tone.value}>
                    {tone.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{copy.personality.replyLength}</Label>
            <Select
              value={form.ai_reply_length}
              onValueChange={(value) => setForm({ ...form, ai_reply_length: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_REPLY_LENGTHS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <ToggleRow
          title={copy.personality.allowEmojis}
          description={copy.personality.allowEmojisDescription}
          checked={form.ai_emoji}
          onChange={(value) => setForm({ ...form, ai_emoji: value })}
        />

        <div className="space-y-1.5">
          <Label htmlFor="instructions">{copy.personality.instructions}</Label>
          <Textarea
            id="instructions"
            rows={5}
            maxLength={2000}
            placeholder={copy.personality.instructionsPlaceholder}
            value={form.ai_custom_instructions}
            onChange={(e) => setForm({ ...form, ai_custom_instructions: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            {copy.personality.charactersCount.replace(
              "{count}",
              String(form.ai_custom_instructions.length),
            )}
          </p>
        </div>
      </Panel>

      <Panel icon={Languages} title={copy.language.title} description={copy.language.description}>
        <div className="grid gap-3 sm:grid-cols-2">
          {AI_LANGUAGES.map((language) => (
            <button
              key={language.value}
              type="button"
              onClick={() => setForm({ ...form, ai_language: language.value })}
              className={cn(
                "rounded-xl border px-4 py-3 text-left text-sm transition-colors",
                form.ai_language === language.value
                  ? "border-primary bg-primary/10 font-semibold"
                  : "border-border bg-surface text-muted-foreground hover:border-primary/40",
              )}
            >
              {language.label}
            </button>
          ))}
        </div>
      </Panel>

      <Panel
        icon={BookOpen}
        title={copy.knowledge.title}
        description={copy.knowledge.description}
      >
        <ToggleRow
          title={copy.knowledge.autoUse}
          description={copy.knowledge.autoUseDescription}
          checked={form.kb_auto_use}
          onChange={(value) => setForm({ ...form, kb_auto_use: value })}
        />
        <ToggleRow
          title={copy.knowledge.strictMode}
          description={copy.knowledge.strictModeDescription}
          checked={form.kb_strict_mode}
          onChange={(value) => setForm({ ...form, kb_strict_mode: value })}
        />
        <ToggleRow
          title={copy.knowledge.escalate}
          description={copy.knowledge.escalateDescription}
          checked={form.kb_escalate_when_unknown}
          onChange={(value) => setForm({ ...form, kb_escalate_when_unknown: value })}
        />
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">{copy.knowledge.articlesPerLookup}</p>
            <span className="text-sm font-semibold text-primary">{form.kb_max_articles}</span>
          </div>
          <Slider
            min={1}
            max={8}
            step={1}
            value={[form.kb_max_articles]}
            onValueChange={([value]) => setForm({ ...form, kb_max_articles: value ?? 4 })}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {copy.knowledge.articlesHint}
          </p>
        </div>
      </Panel>

      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? copy.saving : copy.save}
      </Button>
    </div>
  );
}
