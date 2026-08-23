/**
 * UMRAIO® VOICE V2.1 — voice language resolution.
 *
 * PURE. `voice_language` is a DEDICATED setting; it is never derived from
 * `ai_language` (which governs written replies). Malaysian agencies speak
 * Malaysian Malay by default — voice NEVER silently falls back to "auto".
 */

export const VOICE_LANGUAGES = [
  { value: "ms-MY", label: "Bahasa Malaysia (Malaysia)", asr: "ms" },
  { value: "en-US", label: "English", asr: "en" },
  { value: "id-ID", label: "Bahasa Indonesia", asr: "id" },
  { value: "ar-SA", label: "Arabic", asr: "ar" },
  { value: "zh-CN", label: "Chinese (Simplified)", asr: "zh" },
  { value: "ta-IN", label: "Tamil", asr: "ta" },
  { value: "ur-PK", label: "Urdu", asr: "ur" },
  { value: "bn-BD", label: "Bengali", asr: "bn" },
  { value: "auto", label: "Auto-detect / follow conversation", asr: null },
] as const;

export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]["value"];

export const DEFAULT_VOICE_LANGUAGE: VoiceLanguage = "ms-MY";

const VALUES = VOICE_LANGUAGES.map((l) => l.value) as readonly string[];

/** Missing / unknown / empty → ms-MY. Never "auto". */
export function resolveVoiceLanguage(raw?: string | null): VoiceLanguage {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_VOICE_LANGUAGE;
  if (VALUES.includes(value)) return value as VoiceLanguage;
  // Tolerate bare codes ("ms", "en") from older rows.
  const match = VOICE_LANGUAGES.find(
    (l) => l.asr && (l.asr === value.toLowerCase() || value.toLowerCase().startsWith(`${l.asr}-`)),
  );
  return match ? (match.value as VoiceLanguage) : DEFAULT_VOICE_LANGUAGE;
}

/**
 * ISO-639-1 hint for the transcription model. `null` = let the model
 * auto-detect (the only honest option for "auto").
 */
export function asrLanguageFor(language: string | null | undefined): string | null {
  const resolved = resolveVoiceLanguage(language);
  if (resolved === "auto") return null;
  return VOICE_LANGUAGES.find((l) => l.value === resolved)?.asr ?? null;
}

/** Deterministic Malay speech normalisation applies to Malay only. */
export function usesMalayNormalisation(language: string | null | undefined): boolean {
  return resolveVoiceLanguage(language) === "ms-MY";
}

/**
 * Explicit spoken-language instruction for the TTS engine. Malaysian Malay is
 * spelled out in full so the engine never drifts into Bahasa Indonesia.
 */
export function languageInstruction(language: string | null | undefined): string {
  switch (resolveVoiceLanguage(language)) {
    case "ms-MY":
      return [
        "Speak in Malaysian Malay (Bahasa Malaysia as spoken in Malaysia) only.",
        "Use Malaysian pronunciation, Malaysian vocabulary and Malaysian conversational register",
        "such as boleh, nak, dah, sekejap, pakej, jemaah, berlepas, Datuk, saya boleh bantu.",
        "Do NOT speak Bahasa Indonesia, do NOT use Indonesian pronunciation or Indonesian vocabulary",
        "(never bisa, kamu, banget, gimana, silakan), and do NOT read in stiff textbook Malay",
        "unless the content itself is formal. Keep the rhythm of a real Malaysian conversation.",
      ].join(" ");
    case "en-US":
      return "Speak in clear, natural English with a neutral professional accent.";
    case "id-ID":
      return "Speak in Bahasa Indonesia with Indonesian pronunciation and vocabulary.";
    case "ar-SA":
      return "Speak in Modern Standard Arabic with correct, respectful pronunciation.";
    case "zh-CN":
      return "Speak in Simplified Mandarin Chinese (Putonghua) with natural pronunciation.";
    case "ta-IN":
      return "Speak in Tamil with natural pronunciation.";
    case "ur-PK":
      return "Speak in Urdu with natural pronunciation.";
    case "bn-BD":
      return "Speak in Bengali with natural pronunciation.";
    default:
      return "Speak in the same language the customer used in their message, matching it naturally.";
  }
}
