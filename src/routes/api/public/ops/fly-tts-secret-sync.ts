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

async function assertPlatformOwner(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (token.split(".").length !== 3) return false;

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) return false;

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

async function flyGraphql(flyToken: string, query: string, variables: unknown) {
  const res = await fetch(FLY_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${flyToken}`,
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
  return { status: res.status, parsed };
}

export const Route = createFileRoute("/api/public/ops/fly-tts-secret-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await assertPlatformOwner(request))) {
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

        // Replay/idempotency guard: refuse when the gateway already holds it.
        const listed = await flyGraphql(
          flyToken,
          `query($name:String!){ app(name:$name){ secrets{ name } } }`,
          { name: FLY_APP },
        );
        const existing: string[] =
          listed.parsed?.data?.app?.secrets?.map((s: { name: string }) => s.name) ?? [];
        if (existing.includes("MINIMAX_TTS_API_KEY")) {
          return json(
            { ok: true, already_set: true, gateway_secret_names: existing },
            200,
          );
        }
        if (listed.status !== 200 || !listed.parsed?.data?.app) {
          return json({ ok: false, reason: "fly_app_unreachable" }, 502);
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
