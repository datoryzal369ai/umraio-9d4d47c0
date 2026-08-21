import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorisation for scheduled/server-to-server autonomy hooks.
 *
 * SECURITY: the Supabase publishable key is shipped in the browser bundle and
 * MUST NOT authorise these routes. Callers must present a server-only secret:
 *
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Two trusted sources are accepted, both server-only:
 *  1. process.env.CRON_SECRET  — for external schedulers / manual ops.
 *  2. the vault-stored scheduler secret, verified through a service-role-only
 *     database function (used by pg_cron, which cannot read app env vars).
 *
 * The secret is never logged, never returned, and never exposed to clients.
 */

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Timing-safe comparison over fixed-length digests. */
export function secretsMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const prefix = "bearer ";
  if (!header.toLowerCase().startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

export type CronAuthResult = { ok: true } | { ok: false; response: Response };

function unauthorized(): CronAuthResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

export async function authorizeCronRequest(request: Request): Promise<CronAuthResult> {
  const token = extractBearer(request);
  if (!token) {
    // Never log the header or any token material.
    console.error("[cron-auth] rejected: missing bearer credential");
    return unauthorized();
  }

  const envSecret = process.env["CRON_SECRET"] ?? "";
  if (envSecret && secretsMatch(token, envSecret)) return { ok: true };

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("verify_cron_secret", { token });
    if (!error && data === true) return { ok: true };
  } catch {
    // fall through to rejection
  }

  console.error("[cron-auth] rejected: invalid credential");
  return unauthorized();
}
