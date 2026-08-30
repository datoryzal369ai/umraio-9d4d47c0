/**
 * UMRAIO® — internal Voice Test (administrators/developers only).
 *
 * Synthesizes a short piece of text through an explicitly named engine and
 * returns base64 audio for in-browser playback. It changes no settings, sends
 * no WhatsApp message and touches no business logic.
 *
 * SECURITY: owner-only. Credentials never leave the server; the response
 * carries audio bytes and non-secret diagnostics only.
 */

import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { canManageTestOverride } from "@/lib/testing/owner-test-mode.core";

export const MAX_VOICE_TEST_CHARS = 600;

export type VoiceTestInput = { text: string; engine?: string | null };

export const synthesizeVoiceTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: VoiceTestInput) => {
    const text = (input?.text ?? "").trim();
    if (!text) throw new Error("Enter some text to synthesize.");
    if (text.length > MAX_VOICE_TEST_CHARS) {
      throw new Error(`Keep the test text under ${MAX_VOICE_TEST_CHARS} characters.`);
    }
    const engine = (input?.engine ?? "minimax").trim().toLowerCase();
    return { text, engine };
  })
  .handler(async ({ data, context }) => {
    const { resolveOwnerTestModeContext } = await import("@/lib/testing/owner-test-mode.server");
    const { roles } = await resolveOwnerTestModeContext(context.supabase, context.userId);
    if (!canManageTestOverride(roles)) {
      throw new Error("Voice Test is restricted to agency owners.");
    }

    const { synthesizeSpeech } = await import("./tts.server");
    const started = Date.now();
    const result = await synthesizeSpeech({ text: data.text, provider: data.engine });
    const latencyMs = Date.now() - started;

    if (!result.ok) {
      return {
        ok: false as const,
        engine: result.engine,
        failure: result.kind,
        latencyMs,
      };
    }

    let binary = "";
    for (const byte of result.bytes) binary += String.fromCharCode(byte);
    return {
      ok: true as const,
      engine: result.engine,
      mimeType: result.mimeType,
      bytes: result.bytes.byteLength,
      latencyMs,
      audioBase64: btoa(binary),
    };
  });

/** Non-secret diagnostic: is the MiniMax POC configured on this runtime? */
export const getVoiceTestStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { resolveOwnerTestModeContext } = await import("@/lib/testing/owner-test-mode.server");
    const { roles } = await resolveOwnerTestModeContext(context.supabase, context.userId);
    const canManage = canManageTestOverride(roles);
    if (!canManage) return { canManage: false as const };
    const { describeMinimax } = await import("./minimax.server");
    return { canManage: true as const, minimax: describeMinimax() };
  });
