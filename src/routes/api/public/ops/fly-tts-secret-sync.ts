/**
 * TEMPORARY, SINGLE-USE founder operation — media-plane MiniMax credential
 * transfer to the Fly gateway. DELETE IMMEDIATELY AFTER A CONFIRMED SUCCESS.
 *
 * Security contract:
 *  - POST only, no GET/HEAD discovery surface.
 *  - Requires a valid Supabase bearer token whose user holds platform_owner.
 *  - Reads MINIMAX_TTS_API_KEY (fallback MINIMAX_API_KEY) and FLY_API_TOKEN
 *    from the server runtime ONLY. Never logged, never echoed, never persisted.
 *  - Sets exactly ONE secret on the gateway: MINIMAX_TTS_API_KEY.
 *  - Replay protection: refuses once the gateway already holds the secret.
 *  - Response contains names and booleans only.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const FLY_APP = "umraio-voice-gateway";
const FLY_GRAPHQL = "https://api.fly.io/graphql";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Authorisation: EITHER a platform_owner bearer token OR a single-use
 * operations token whose SHA-256 hash is pre-seeded server-side. The one-time
 * token is consumed atomically (used_at IS NULL guard), so replay fails.
 */
async function authorize(request: Request): Promise<boolean> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) return false;

  const opsToken = request.headers.get("x-ops-token")?.trim();
  if (opsToken) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opsToken));
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("ops_one_time_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token_hash", hash)
      .eq("purpose", "fly_tts_secret_sync")
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("id");
    if (!error && Array.isArray(data) && data.length === 1) return true;
    return false;
  }

  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (token.split(".").length !== 3) return false;

  const supabase = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}`, apikey: key } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  const userId = data?.claims?.sub;
  if (error || !userId) return false;

  const roles = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "platform_owner")
    .limit(1);
  return !roles.error && Array.isArray(roles.data) && roles.data.length > 0;
}

/**
 * Fly accepts either a raw personal token or a "FlyV1 …" deploy token. Both
 * header shapes are attempted; the token value itself is never returned.
 */
async function flyGraphql(flyToken: string, query: string, variables: unknown) {
  const candidates = flyToken.startsWith("FlyV1")
    ? [flyToken, flyToken.replace(/^FlyV1\s+/, "")]
    : [flyToken, `FlyV1 ${flyToken}`];

  let last: { status: number; parsed: any } = { status: 0, parsed: null };
  for (const candidate of candidates) {
    const res = await fetch(FLY_GRAPHQL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${candidate}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    last = { status: res.status, parsed };
    if (res.status === 200 && parsed?.data && !parsed?.errors) return last;
  }
  return last;
}

export const Route = createFileRoute("/api/public/ops/fly-tts-secret-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await authorize(request))) {
          return json({ ok: false, reason: "forbidden" }, 403);
        }

        const minimaxKey =
          process.env["MINIMAX_TTS_API_KEY"] || process.env["MINIMAX_API_KEY"] || "";
        const flyToken = process.env["FLY_API_TOKEN"] || "";
        if (!minimaxKey || !flyToken) {
          return json(
            {
              ok: false,
              reason: "missing_runtime_credentials",
              minimax_present: Boolean(minimaxKey),
              fly_token_present: Boolean(flyToken),
            },
            412,
          );
        }

        // Token-validity probe against the app-scoped Machines API (status only).
        const probe = await fetch(`https://api.machines.dev/v1/apps/${FLY_APP}`, {
          headers: { Authorization: `Bearer ${flyToken}` },
        });
        const probeAlt = probe.ok
          ? null
          : await fetch(`https://api.machines.dev/v1/apps/${FLY_APP}`, {
              headers: { Authorization: `Bearer FlyV1 ${flyToken}` },
            });

        // Replay/idempotency guard: refuse when the gateway already holds it.
        const listed = await flyGraphql(
          flyToken,
          `query($name:String!){ app(name:$name){ secrets{ name } } }`,
          { name: FLY_APP },
        );
        (listed as any).probe = { machines: probe.status, machines_flyv1: probeAlt?.status ?? null };

        const existing: string[] =
          listed.parsed?.data?.app?.secrets?.map((s: { name: string }) => s.name) ?? [];
        if (existing.includes("MINIMAX_TTS_API_KEY")) {
          return json(
            { ok: true, already_set: true, gateway_secret_names: existing },
            200,
          );
        }
        if (listed.status !== 200 || !listed.parsed?.data?.app) {
          // Sanitized provider diagnostics only — never credentials.
          const messages: string[] = (listed.parsed?.errors ?? [])
            .map((e: { message?: string }) => String(e?.message ?? ""))
            .slice(0, 3);
          return json(
            {
              ok: false,
              reason: "fly_app_unreachable",
              fly_status: listed.status,
              fly_errors: messages,
              probe: (listed as any).probe ?? null,
            },
            502,
          );

        }


        const set = await flyGraphql(
          flyToken,
          `mutation($input:SetSecretsInput!){ setSecrets(input:$input){ app{ name } release{ version } } }`,
          {
            input: {
              appId: FLY_APP,
              secrets: [{ key: "MINIMAX_TTS_API_KEY", value: minimaxKey }],
            },
          },
        );
        if (set.status !== 200 || set.parsed?.errors) {
          return json({ ok: false, reason: "fly_set_secret_failed" }, 502);
        }

        const after = await flyGraphql(
          flyToken,
          `query($name:String!){ app(name:$name){ secrets{ name } } }`,
          { name: FLY_APP },
        );
        const names: string[] =
          after.parsed?.data?.app?.secrets?.map((s: { name: string }) => s.name) ?? [];

        return json(
          {
            ok: names.includes("MINIMAX_TTS_API_KEY"),
            already_set: false,
            gateway_secret_names: names,
            release: set.parsed?.data?.setSecrets?.release?.version ?? null,
          },
          200,
        );
      },
    },
  },
});
