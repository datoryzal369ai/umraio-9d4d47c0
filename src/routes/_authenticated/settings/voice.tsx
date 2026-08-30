import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AudioLines, Gauge, Info, Languages, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { fetchAgency, fetchSettings, updateSettings } from "@/lib/settings";
import { getUsageOverview } from "@/lib/billing/usage.functions";
import {
  DEFAULT_VOICE_LANGUAGE,
  VOICE_LANGUAGES,
  resolveVoiceLanguage,
  type VoiceLanguage,
} from "@/lib/voice/language.core";
import { prepareSpokenResponse } from "@/lib/voice/presentation.core";
import {
  VOICE_CONTROL_KEYS,
  VOICE_CONTROL_SUPPORT,
  VOICE_PERSONAS,
  VOICE_PERSONA_KEYS,
  DEFAULT_VOICE_PERSONA,
  resolvePersona,
  type VoiceControlKey,
  type VoicePersonaKey,
} from "@/lib/voice/persona.core";
import {
  getVoiceTestStatus,
  synthesizeVoiceTest,
} from "@/lib/voice/voice-test.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/voice")({
  head: () => ({
    meta: [
      { title: "Voice Persona Console — UMRAIO" },
      {
        name: "description",
        content:
          "Tune how UMRAIO sounds on WhatsApp voice notes: persona preset, naturalness, warmth, energy, confidence, expression, pace and pauses.",
      },
      { property: "og:title", content: "Voice Persona Console — UMRAIO" },
      {
        property: "og:description",
        content: "Natural Malaysian conversational speech for your AI voice replies.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: VoiceSettingsPage,
});

const CONTROL_COPY: Record<VoiceControlKey, { title: string; left: string; right: string; hint: string }> = {
  naturalness: {
    title: "Naturalness",
    left: "Robotic",
    right: "Human",
    hint: "Rewrites written Malay into spoken Malay before synthesis.",
  },
  warmth: { title: "Warmth", left: "Formal", right: "Warm", hint: "Steers delivery warmth." },
  energy: { title: "Energy", left: "Calm", right: "Energetic", hint: "Steers delivery energy." },
  confidence: {
    title: "Confidence",
    left: "Soft",
    right: "Confident",
    hint: "Steers conviction in delivery.",
  },
  expression: {
    title: "Expression",
    left: "Neutral",
    right: "Expressive",
    hint: "Steers intonation range.",
  },
  pace: {
    title: "Pace",
    left: "Slow",
    right: "Conversational",
    hint: "Real engine speaking-rate parameter.",
  },
  pause: {
    title: "Pause",
    left: "Minimal",
    right: "Natural",
    hint: "Inserts real clause breaks and breathing points.",
  },
};

const SUPPORT_BADGE: Record<string, { label: string; tone: string }> = {
  presentation: { label: "Applied in text preparation", tone: "border-emerald-500/40 text-emerald-400" },
  engine: { label: "Engine parameter", tone: "border-primary/40 text-primary" },
  engine_partial: {
    label: "Guidance only — engine has no numeric control",
    tone: "border-amber-500/40 text-amber-400",
  },
};

const SAMPLE =
  "Baik Datuk. Untuk pakej Umrah Disember, terdapat beberapa pilihan. Harga bermula daripada RM5,990 seorang. Tarikh berlepas 23/12/2026. Adakah Datuk mahu saya membantu Datuk dengan pakej tersebut?";

const VOICE_TEST_SENTENCE =
  "Assalamualaikum, saya UMRAIO. Saya boleh membantu pihak tuan mengurus pertanyaan jemaah, membuat susulan pelanggan dan membantu pasukan jualan bekerja dengan lebih pantas.";

/** Owner-only internal Voice Test. Generates audio; changes no settings. */
function VoiceTestCard() {
  const { data: status } = useQuery({ queryKey: ["voice-test-status"], queryFn: () => getVoiceTestStatus() });
  const [text, setText] = useState(VOICE_TEST_SENTENCE);
  const [engine, setEngine] = useState("minimax");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => synthesizeVoiceTest({ data: { text, engine } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setAudioUrl(null);
        setInfo(`Failed on ${result.engine} (${result.failure}) after ${result.latencyMs}ms.`);
        toast.error(`Voice test failed: ${result.failure}`);
        return;
      }
      const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
      setAudioUrl(URL.createObjectURL(new Blob([bytes], { type: result.mimeType })));
      setInfo(
        `${result.engine} · ${result.mimeType} · ${result.bytes} bytes · ${result.latencyMs}ms`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!status?.canManage) return null;

  return (
    <section className="panel space-y-3 p-5">
      <header className="flex items-start gap-3">
        <div className="rounded-xl border border-border/60 bg-surface p-2.5">
          <AudioLines className="size-4 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-base font-semibold tracking-tight">
            Voice Test (internal)
          </h2>
          <p className="text-xs text-muted-foreground">
            Owner-only. Generates audio directly from a chosen engine. Nothing is sent to
            customers and no setting is changed. MiniMax Speech 2.8 HD is a proof of concept:{" "}
            {status.minimax.configured
              ? `configured (${status.minimax.model})`
              : "not configured on this runtime"}
            .
          </p>
        </div>
      </header>
      <div className="flex flex-wrap gap-2">
        {["minimax", "openai"].map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setEngine(option)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-xs transition-colors",
              engine === option
                ? "border-primary bg-primary/5 text-primary"
                : "border-border bg-surface hover:border-primary/40",
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        aria-label="Voice test text"
        className="w-full rounded-lg border border-border bg-surface p-3 text-sm outline-none focus:border-primary/50"
      />
      <div className="flex items-center gap-3">
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? "Generating…" : "Generate audio"}
        </Button>
        {info ? <span className="text-xs text-muted-foreground">{info}</span> : null}
      </div>
      {audioUrl ? <audio controls src={audioUrl} className="w-full" /> : null}
    </section>
  );
}

function VoiceSettingsPage() {
  const queryClient = useQueryClient();
  const { data: agency } = useQuery({ queryKey: ["agency"], queryFn: fetchAgency });
  const { data: settings, isLoading } = useQuery({
    queryKey: ["agency-settings", agency?.id],
    queryFn: () => fetchSettings(agency!.id),
    enabled: Boolean(agency?.id),
  });

  const { data: usage } = useQuery({ queryKey: ["usage-overview"], queryFn: getUsageOverview });

  const [persona, setPersona] = useState<VoicePersonaKey>(DEFAULT_VOICE_PERSONA);
  const [language, setLanguage] = useState<VoiceLanguage>(DEFAULT_VOICE_LANGUAGE);
  const [controls, setControls] = useState(VOICE_PERSONAS[DEFAULT_VOICE_PERSONA].controls);

  useEffect(() => {
    if (!settings) return;
    const resolved = resolvePersona({
      persona: settings.voice_persona,
      controls: settings.voice_controls ?? {},
      voice: settings.voice_name,
    });
    setPersona(resolved.key);
    setControls(resolved.controls);
    setLanguage(resolveVoiceLanguage(settings.voice_language));
  }, [settings]);

  const mutation = useMutation({
    mutationFn: () =>
      updateSettings(settings!.id, {
        voice_persona: persona,
        voice_controls: controls,
        voice_language: language,
      } as never),
    onSuccess: () => {
      toast.success("Voice persona saved.");
      void queryClient.invalidateQueries({ queryKey: ["agency-settings"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const preview = prepareSpokenResponse({
    replyText: SAMPLE,
    persona: { persona, controls },
    language,
  });

  if (isLoading || !settings) return <Skeleton className="h-96 w-full rounded-xl" />;

  return (
    <div className="space-y-6">
      <section className="panel space-y-4 p-5">
        <header className="flex items-start gap-3">
          <div className="rounded-xl border border-border/60 bg-surface p-2.5">
            <Sparkles className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight">Voice persona</h2>
            <p className="text-xs text-muted-foreground">
              How UMRAIO sounds on WhatsApp voice notes. Text replies are never changed.
            </p>
          </div>
        </header>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {VOICE_PERSONA_KEYS.map((key) => {
            const p = VOICE_PERSONAS[key];
            const active = persona === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setPersona(key);
                  setControls(p.controls);
                }}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface hover:border-primary/40",
                )}
              >
                <p className="text-sm font-medium">{p.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                {key === DEFAULT_VOICE_PERSONA ? (
                  <Badge variant="outline" className="mt-2 text-[10px]">
                    Default
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel space-y-4 p-5">
        <header className="flex items-start gap-3">
          <div className="rounded-xl border border-border/60 bg-surface p-2.5">
            <Languages className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight">Voice language</h2>
            <p className="text-xs text-muted-foreground">
              The spoken language for voice notes. This is separate from your written AI reply
              language. Malaysian Malay is enforced explicitly — the engine is instructed never to
              drift into Bahasa Indonesia.
            </p>
          </div>
        </header>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {VOICE_LANGUAGES.map((option) => {
            const active = language === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setLanguage(option.value)}
                className={cn(
                  "rounded-xl border p-3 text-left text-sm transition-colors",
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface hover:border-primary/40",
                )}
              >
                <span className="font-medium">{option.label}</span>
                {option.value === DEFAULT_VOICE_LANGUAGE ? (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    Default
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Voice notes you receive are transcribed with this language hint too. “Auto-detect” lets
          the model decide, which is best for mixed Malay-English speech.
        </p>
      </section>

      <section className="panel space-y-3 p-5">
        <header className="flex items-start gap-3">
          <div className="rounded-xl border border-border/60 bg-surface p-2.5">
            <Gauge className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight">Voice usage</h2>
            <p className="text-xs text-muted-foreground">
              Voice minutes are metered per calendar month against your active plan.
            </p>
          </div>
        </header>
        {usage ? (
          <>
            <p className="text-sm">
              <span className="font-medium">
                {usage.voice.usedMinutes} / {usage.voice.limitMinutes} minutes
              </span>{" "}
              used this month · {usage.voice.remainingMinutes} remaining
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
              <div
                className={cn(
                  "h-full rounded-full",
                  usage.voice.remainingMinutes === 0 ? "bg-destructive" : "bg-primary",
                )}
                style={{
                  width: `${Math.min(100, usage.voice.limitMinutes > 0 ? (usage.voice.usedMinutes / usage.voice.limitMinutes) * 100 : 0)}%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Active plan: {usage.plan.label}. When the allowance is reached, UMRAIO tells the
              customer plainly that voice is unavailable and continues in text — it never pretends
              the voice note failed.
            </p>
          </>
        ) : (
          <Skeleton className="h-16 w-full rounded-lg" />
        )}
      </section>

      <section className="panel space-y-5 p-5">
        <header className="flex items-start gap-3">
          <div className="rounded-xl border border-border/60 bg-surface p-2.5">
            <AudioLines className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight">Voice console</h2>
            <p className="text-xs text-muted-foreground">
              Every control below does real work. Controls the current engine cannot honour
              numerically are labelled as guidance rather than faked.
            </p>
          </div>
        </header>

        {VOICE_CONTROL_KEYS.map((key) => {
          const copy = CONTROL_COPY[key];
          const support = SUPPORT_BADGE[VOICE_CONTROL_SUPPORT[key]]!;
          return (
            <div key={key} className="space-y-2 rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{copy.title}</p>
                <Badge variant="outline" className={cn("text-[10px]", support.tone)}>
                  {support.label}
                </Badge>
              </div>
              <Slider
                value={[controls[key]]}
                min={0}
                max={100}
                step={1}
                aria-label={copy.title}
                onValueChange={([value]) =>
                  setControls((prev) => ({ ...prev, [key]: value ?? prev[key] }))
                }
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{copy.left}</span>
                <span>{controls[key]}</span>
                <span>{copy.right}</span>
              </div>
              <p className="text-xs text-muted-foreground">{copy.hint}</p>
            </div>
          );
        })}

        <div className="flex justify-end">
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save voice persona"}
          </Button>
        </div>
      </section>

      <section className="panel space-y-3 p-5">
        <header className="flex items-start gap-3">
          <div className="rounded-xl border border-border/60 bg-surface p-2.5">
            <Info className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight">
              Spoken preview
            </h2>
            <p className="text-xs text-muted-foreground">
              Deterministic preview of what the voice engine receives — no audio is generated here.
            </p>
          </div>
        </header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Text reply</p>
        <p className="rounded-lg border border-border bg-surface p-3 text-sm">{SAMPLE}</p>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Spoken rendering</p>
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          {preview.spokenText}
        </p>
        <p className="text-xs text-muted-foreground">
          Estimated {preview.estimatedSeconds}s ({preview.lengthClass}) · engine speed{" "}
          {preview.speed}× · voice {preview.voice}
        </p>
      </section>

      <VoiceTestCard />
    </div>
  );
}
