/**
 * UMRAIO® VOICE NATURALNESS V2 — voice persona model.
 *
 * PURE. Defines the persona presets, the seven console controls and the
 * deterministic mapping from those controls to (a) presentation-layer
 * behaviour and (b) engine parameters. Controls the current engine cannot
 * honour are declared unsupported instead of being faked.
 */

import { languageInstruction } from "./language.core";

export const VOICE_CONTROL_KEYS = [
  "naturalness",
  "warmth",
  "energy",
  "confidence",
  "expression",
  "pace",
  "pause",
] as const;

export type VoiceControlKey = (typeof VOICE_CONTROL_KEYS)[number];

/** 0..100 for every control. 0 = left label, 100 = right label. */
export type VoiceControls = Record<VoiceControlKey, number>;

export type VoiceControlSupport = "presentation" | "engine" | "engine_partial";

/**
 * How each control is honoured TODAY.
 * - presentation  : fully applied in the Voice Presentation Layer (deterministic).
 * - engine        : mapped to a real engine parameter (OpenAI TTS `speed`).
 * - engine_partial: steered through natural-language `instructions` only; the
 *                   engine exposes no numeric parameter for it. Not faked —
 *                   the console labels it as guidance, not a guarantee.
 */
export const VOICE_CONTROL_SUPPORT: Record<VoiceControlKey, VoiceControlSupport> = {
  naturalness: "presentation",
  warmth: "engine_partial",
  energy: "engine_partial",
  confidence: "engine_partial",
  expression: "engine_partial",
  pace: "engine",
  pause: "presentation",
};

/** Controls no current engine can honour numerically (never faked). */
export const UNSUPPORTED_ENGINE_CONTROLS: VoiceControlKey[] = VOICE_CONTROL_KEYS.filter(
  (key) => VOICE_CONTROL_SUPPORT[key] === "engine_partial",
);

export const VOICE_PERSONA_KEYS = [
  "premium_sales_executive",
  "warm_malaysian_consultant",
  "friendly",
  "professional",
  "calm",
  "confident",
  "empathetic",
] as const;

export type VoicePersonaKey = (typeof VOICE_PERSONA_KEYS)[number];

export const DEFAULT_VOICE_PERSONA: VoicePersonaKey = "premium_sales_executive";

export type VoicePersonaPreset = {
  key: VoicePersonaKey;
  label: string;
  description: string;
  voice: string;
  controls: VoiceControls;
};

const preset = (
  key: VoicePersonaKey,
  label: string,
  description: string,
  voice: string,
  controls: VoiceControls,
): VoicePersonaPreset => ({ key, label, description, voice, controls });

export const VOICE_PERSONAS: Record<VoicePersonaKey, VoicePersonaPreset> = {
  premium_sales_executive: preset(
    "premium_sales_executive",
    "Premium Sales Executive",
    "Warm, confident, calm and unhurried — a senior Malaysian Umrah consultant.",
    "alloy",
    { naturalness: 85, warmth: 72, energy: 45, confidence: 78, expression: 55, pace: 62, pause: 65 },
  ),
  warm_malaysian_consultant: preset(
    "warm_malaysian_consultant",
    "Warm Malaysian Consultant",
    "Familiar, kampung-warm and reassuring, still professional.",
    "shimmer",
    { naturalness: 92, warmth: 90, energy: 48, confidence: 62, expression: 66, pace: 58, pause: 72 },
  ),
  friendly: preset(
    "friendly",
    "Friendly",
    "Light, approachable and easy-going.",
    "nova",
    { naturalness: 88, warmth: 82, energy: 68, confidence: 58, expression: 72, pace: 70, pause: 55 },
  ),
  professional: preset(
    "professional",
    "Professional",
    "Composed and businesslike without sounding stiff.",
    "onyx",
    { naturalness: 70, warmth: 45, energy: 45, confidence: 72, expression: 38, pace: 60, pause: 55 },
  ),
  calm: preset(
    "calm",
    "Calm",
    "Slow, steady and settling — good for anxious first-time pilgrims.",
    "alloy",
    { naturalness: 80, warmth: 70, energy: 22, confidence: 60, expression: 35, pace: 40, pause: 80 },
  ),
  confident: preset(
    "confident",
    "Confident",
    "Assured and decisive, closes without pressure.",
    "onyx",
    { naturalness: 78, warmth: 52, energy: 62, confidence: 92, expression: 52, pace: 68, pause: 50 },
  ),
  empathetic: preset(
    "empathetic",
    "Empathetic",
    "Soft, patient and attentive to concern.",
    "shimmer",
    { naturalness: 86, warmth: 95, energy: 30, confidence: 50, expression: 62, pace: 48, pause: 78 },
  ),
};

export function clampControl(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function resolvePersona(input?: {
  persona?: string | null;
  controls?: Partial<Record<string, unknown>> | null;
  voice?: string | null;
}): { key: VoicePersonaKey; voice: string; controls: VoiceControls } {
  const key = (VOICE_PERSONA_KEYS as readonly string[]).includes(input?.persona ?? "")
    ? (input!.persona as VoicePersonaKey)
    : DEFAULT_VOICE_PERSONA;
  const base = VOICE_PERSONAS[key];
  const controls = { ...base.controls } as VoiceControls;
  for (const control of VOICE_CONTROL_KEYS) {
    const override = input?.controls?.[control];
    if (override !== undefined && override !== null) controls[control] = clampControl(override);
  }
  return { key, voice: input?.voice?.trim() || base.voice, controls };
}

/** OpenAI TTS accepts 0.25–4.0; we stay inside a human conversational band. */
export function paceToSpeed(pace: number): number {
  const p = clampControl(pace);
  return Math.round((0.82 + (p / 100) * 0.36) * 100) / 100; // 0.82 – 1.18
}

function band(value: number, low: string, mid: string, high: string): string {
  if (value <= 33) return low;
  if (value >= 67) return high;
  return mid;
}

/**
 * Natural-language steering for engines that accept it (OpenAI TTS).
 * Engine-partial controls live here — clearly guidance, never a fake parameter.
 */
export function buildVoiceInstructions(controls: VoiceControls, language = "ms-MY"): string {
  const parts = [
    "You are a senior Malaysian Umrah travel consultant speaking on a WhatsApp voice note to a valued customer.",
    languageInstruction(language),

    band(
      controls.warmth,
      "Keep the tone neutral and businesslike.",
      "Sound personable and courteous.",
      "Sound genuinely warm, like speaking to a respected family friend.",
    ),
    band(
      controls.energy,
      "Stay low-key and settled; no brightness or push.",
      "Keep an even, comfortable energy.",
      "Keep the delivery lively and engaged, never shouty.",
    ),
    band(
      controls.confidence,
      "Speak gently and modestly.",
      "Speak with quiet assurance.",
      "Speak with clear conviction — you know these packages well.",
    ),
    band(
      controls.expression,
      "Keep intonation flat and even.",
      "Use light, natural intonation.",
      "Use expressive rises and falls, the way a person really talks.",
    ),
    band(
      controls.pause,
      "Keep pauses minimal and keep the sentences flowing.",
      "Take a short breath at commas and a real pause at full stops.",
      "Take unhurried, natural breaths between thoughts, as in a relaxed conversation.",
    ),
    band(
      controls.naturalness,
      "Read the text as written.",
      "Speak conversationally rather than reading aloud.",
      "Speak as a human consultant would in a real conversation — never like a news reader, IVR or audiobook narrator.",
    ),
    "Pronounce Arabic and Islamic terms respectfully and exactly as written. Never spell out punctuation, symbols, links or reference codes, and never read the text like a news reader, IVR or audiobook narrator.",
  ];
  return parts.join(" ");
}
