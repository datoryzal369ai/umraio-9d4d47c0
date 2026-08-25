/**
 * Meta Embedded Signup — server-only Graph calls.
 *
 * The exchanged business access token stays inside this module and the
 * `whatsapp_configs.access_token` column. It is never returned to the browser
 * and never logged.
 */
import { META_GRAPH_VERSION } from "./embedded-signup.core";

const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const TIMEOUT_MS = 12_000;

async function graphFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function metaAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env["META_APP_ID"] ?? "";
  const appSecret = process.env["META_APP_SECRET"] ?? "";
  if (!appId || !appSecret) {
    throw new Error("WhatsApp onboarding is not configured yet. Contact support.");
  }
  return { appId, appSecret };
}

/** Exchange the Embedded Signup authorization code for a business access token. */
export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const { appId, appSecret } = metaAppCredentials();
  const url =
    `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`;

  const res = await graphFetch(url, { method: "GET" });
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !body?.access_token) {
    console.error(`[whatsapp-signup] code exchange failed status=${res.status}`);
    throw new Error("Meta rejected the connection request. Please try again.");
  }
  return body.access_token;
}

/** Subscribe this app to the newly connected WABA so webhooks are delivered. */
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  const res = await graphFetch(`${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    console.error(`[whatsapp-signup] waba subscribe failed status=${res.status}`);
    throw new Error("Could not finish connecting WhatsApp. Please try again.");
  }
}

/** Best-effort display number lookup; failure must not fail the connection. */
export async function fetchDisplayPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await graphFetch(
      `${GRAPH}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { display_phone_number?: string };
    return body.display_phone_number ?? null;
  } catch {
    return null;
  }
}
