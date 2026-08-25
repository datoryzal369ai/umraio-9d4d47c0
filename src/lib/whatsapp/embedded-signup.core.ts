/**
 * Meta WhatsApp Embedded Signup v4 — pure client/server-shared contract.
 *
 * No network, no secrets. The App Secret NEVER appears here; only the public
 * App ID and the existing Meta Login configuration id are used in the browser.
 */

/** Existing Facebook Login for Business configuration ("UMRAIO Agency Onboarding"). */
export const EMBEDDED_SIGNUP_CONFIG_ID = "1417864223589309";
export const EMBEDDED_SIGNUP_VERSION = "v4";
export const META_GRAPH_VERSION = "v21.0";

/** Exact launch shape documented by the Meta dashboard for Embedded Signup v4. */
export function buildEmbeddedSignupLaunchParams() {
  return {
    config_id: EMBEDDED_SIGNUP_CONFIG_ID,
    response_type: "code" as const,
    override_default_response_type: true,
    extras: { version: EMBEDDED_SIGNUP_VERSION },
  };
}

/** Only these origins may deliver Embedded Signup session information. */
const TRUSTED_META_ORIGINS = new Set([
  "https://www.facebook.com",
  "https://web.facebook.com",
  "https://business.facebook.com",
  "https://facebook.com",
]);

export function isTrustedMetaOrigin(origin: unknown): boolean {
  return typeof origin === "string" && TRUSTED_META_ORIGINS.has(origin);
}

export type EmbeddedSignupSessionInfo = {
  wabaId: string;
  phoneNumberId: string;
};

/**
 * Parse the Embedded Signup `message` event payload. Returns null for anything
 * that is not a finished WA_EMBEDDED_SIGNUP session — unrelated postMessages
 * from any origin must be ignored, never partially trusted.
 */
export function parseEmbeddedSignupMessage(
  origin: unknown,
  raw: unknown,
): EmbeddedSignupSessionInfo | null {
  if (!isTrustedMetaOrigin(origin)) return null;

  let payload: unknown = raw;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const message = payload as { type?: unknown; event?: unknown; data?: unknown };
  if (message.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (message.event !== "FINISH" && message.event !== "FINISH_ONLY_WABA") return null;

  const data = (message.data ?? {}) as { waba_id?: unknown; phone_number_id?: unknown };
  const wabaId = typeof data.waba_id === "string" ? data.waba_id : "";
  const phoneNumberId = typeof data.phone_number_id === "string" ? data.phone_number_id : "";
  if (!wabaId || !phoneNumberId) return null;

  return { wabaId, phoneNumberId };
}
