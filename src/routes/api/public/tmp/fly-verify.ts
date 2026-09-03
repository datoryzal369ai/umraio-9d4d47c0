import { createFileRoute } from "@tanstack/react-router";

/**
 * TEMPORARY — one-shot token verification (deleted immediately after use).
 *
 * Verifies that FLY_API_TOKEN can authenticate to Fly.io and access both
 * the organization "Dato Ryzal 369" and the app "umraio-voice-gateway".
 * The token is read only from the environment and is never logged, returned,
 * or persisted.
 *
 * Caller verification: a valid platform-owner Supabase bearer token.
 */

const FLY_GQL = "https://api.fly.io/graphql";
const APP = "umraio-voice-gateway";
const ORG = "Dato Ryzal 369";

async function gql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(FLY_GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

function extractErrors(body: unknown): string[] {
  const b = body as { errors?: Array<{ message?: string }> } | null;
  return (b?.errors ?? []).map((e) => String(e.message ?? "unknown")).slice(0, 3);
}

export const Route = createFileRoute("/api/public/tmp/fly-verify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // --- Verify caller is the platform owner ---
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!bearer) return new Response("Unauthorized", { status: 401 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(bearer);
        if (userErr || !userData?.user) return new Response("Unauthorized", { status: 401 });

        const { data: roles } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "platform_owner")
          .limit(1);
        if (!roles || roles.length === 0) return new Response("Forbidden", { status: 403 });

        // --- Token verification ---
        const token = process.env["FLY_API_TOKEN"];
        if (!token) {
          return Response.json(
            { token_authenticated: "NO", organization_access: "NO", app_access: "NO", error: "token_not_available" },
            { status: 500 },
          );
        }

        const report: Record<string, string> = {
          token_authenticated: "NO",
          organization_access: "NO",
          app_access: "NO",
        };

        // 1) Token authenticated? Use a lightweight query.
        const meQuery = `query { __schema { queryType { name } } }`;
        const me = await gql(token, meQuery, {});
        if (me.status === 200 && extractErrors(me.body).length === 0) {
          report["token_authenticated"] = "YES";
        }

        // 2) Organization access?
        const orgQuery = `query($slug: String!) {
          organization(slug: $slug) {
            id
            name
            slug
          }
        }`;
        const orgRes = await gql(token, orgQuery, { slug: ORG });
        const orgErrors = extractErrors(orgRes.body);
        const orgData = (orgRes.body as { data?: { organization?: { id?: string } } } | null)?.data;
        if (orgRes.status === 200 && orgErrors.length === 0 && orgData?.organization?.id) {
          report["organization_access"] = "YES";
        }

        // 3) App access?
        const appQuery = `query($name: String!) {
          app(name: $name) {
            name
            id
            organization { id name }
          }
        }`;
        const appRes = await gql(token, appQuery, { name: APP });
        const appErrors = extractErrors(appRes.body);
        const appData = (appRes.body as { data?: { app?: { id?: string } } } | null)?.data;
        if (appRes.status === 200 && appErrors.length === 0 && appData?.app?.id) {
          report["app_access"] = "YES";
        }

        return Response.json(report);
      },
    },
  },
});
