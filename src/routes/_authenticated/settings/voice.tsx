import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AudioLines, Info, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { fetchAgency, fetchSettings, updateSettings } from "@/lib/settings";
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

function VoiceSettingsPage() {
  const queryClient = useQueryClient();
  const { data: agency } = useQuery({ queryKey: ["agency"], queryFn: fetchAgency });
  const { data: settings, isLoading } = useQuery({
    queryKey: ["agency-settings", agency?.id],
    queryFn: () => fetchSettings(agency!.id),
    enabled: Boolean(agency?.id),
  });

  const [persona, setPersona] = useState<VoicePersonaKey>(DEFAULT_VOICE_PERSONA);
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
  }, [settings]);

  const mutation = useMutation({
    mutationFn: () =>
      updateSettings(settings!.id, {
        voice_persona: persona,
        voice_controls: controls,
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
    </div>
  );
}
