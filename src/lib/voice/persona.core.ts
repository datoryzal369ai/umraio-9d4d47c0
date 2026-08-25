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
    // `marin` is the most natural, least announcer-like voice currently
    // supported by gpt-4o-mini-tts (verified against the live voice list).
    "marin",
    { naturalness: 92, warmth: 76, energy: 48, confidence: 74, expression: 62, pace: 55, pause: 58 },
  ),
  warm_malaysian_consultant: preset(
    "warm_malaysian_consultant",
    "Warm Malaysian Consultant",
    "Familiar, kampung-warm and reassuring, still professional.",
    "coral",
    { naturalness: 94, warmth: 90, energy: 50, confidence: 62, expression: 68, pace: 52, pause: 62 },
  ),
  friendly: preset(
    "friendly",
    "Friendly",
    "Light, approachable and easy-going.",
    "nova",
    { naturalness: 90, warmth: 82, energy: 66, confidence: 58, expression: 72, pace: 60, pause: 52 },
  ),
  professional: preset(
    "professional",
    "Professional",
    "Composed and businesslike without sounding stiff.",
    "cedar",
    { naturalness: 78, warmth: 48, energy: 46, confidence: 72, expression: 44, pace: 55, pause: 52 },
  ),
  calm: preset(
    "calm",
    "Calm",
    "Slow, steady and settling — good for anxious first-time pilgrims.",
    "sage",
    { naturalness: 86, warmth: 72, energy: 26, confidence: 60, expression: 40, pace: 42, pause: 72 },
  ),
  confident: preset(
    "confident",
    "Confident",
    "Assured and decisive, closes without pressure.",
    "marin",
    { naturalness: 84, warmth: 56, energy: 60, confidence: 90, expression: 56, pace: 62, pause: 48 },
  ),
  empathetic: preset(
    "empathetic",
    "Empathetic",
    "Soft, patient and attentive to concern.",
    "coral",
    { naturalness: 90, warmth: 95, energy: 32, confidence: 52, expression: 64, pace: 48, pause: 70 },
  ),
};

/** Voices the current gpt-4o-mini-tts endpoint accepts (verified live). */
export const SUPPORTED_TTS_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
  "coral",
  "verse",
  "ballad",
  "ash",
  "sage",
  "marin",
  "cedar",
] as const;

export function isSupportedTtsVoice(voice: string): boolean {
  return (SUPPORTED_TTS_VOICES as readonly string[]).includes((voice || "").trim().toLowerCase());
}


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
  // An unsupported custom voice would be rejected by the engine; fall back to
  // the persona's own voice instead of failing the whole voice turn.
  const requested = input?.voice?.trim().toLowerCase() ?? "";
  const voice = requested && isSupportedTtsVoice(requested) ? requested : base.voice;
  return { key, voice, controls };
}

/**
 * OpenAI TTS accepts 0.25–4.0. Anything outside a narrow band sounds
 * mechanically sped up or dragged, so we stay inside a genuinely
 * conversational range and let the delivery come from the instructions.
 */
export function paceToSpeed(pace: number): number {
  const p = clampControl(pace);
  return Math.round((0.9 + (p / 100) * 0.18) * 100) / 100; // 0.90 – 1.08
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
    "Sound like a real Malaysian customer-service consultant on a phone call: no robotic pronunciation, no monotone, no announcer or radio-presenter delivery, no exaggerated emotion, no long unnatural silences and no rushing.",
    "Pronounce Arabic and Islamic terms respectfully and exactly as written. Never spell out punctuation, symbols, links or reference codes, and never read the text like a news reader, IVR or audiobook narrator.",
  ];
  return parts.join(" ");
}
