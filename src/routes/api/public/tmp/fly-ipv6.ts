import { createFileRoute } from "@tanstack/react-router";

/**
 * TEMPORARY — one-shot infrastructure operation (deleted immediately after use).
 *
 * Allocates a public IPv6 for the existing Fly.io app umraio-voice-gateway
 * using the FLY_API_TOKEN env secret (Fly GraphQL API — the same API flyctl
 * `ips allocate-v6` uses), verifies app state, and returns a sanitized report.
 * The token is read only from the environment and is never logged, returned,
 * or persisted.
 *
 * Caller verification: a valid platform-owner Supabase bearer token.
 */

const FLY_GQL = "https://api.fly.io/graphql";
const FLY_API = "https://api.machines.dev/v1";
const APP = "umraio-voice-gateway";

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

const LIST_QUERY = `query($name: String!) {
  app(name: $name) {
    name
    ipAddresses { nodes { id address type region createdAt } }
  }
}`;

const ALLOCATE_V6 = `mutation($input: AllocateIPAddressInput!) {
  allocateIpAddress(input: $input) {
    ipAddress { id address type region }
    clientMutationId
  }
}`;

type IpNode = { id?: string; address?: string; type?: string; region?: string };

function extractIps(body: unknown): IpNode[] {
  const b = body as {
    data?: { app?: { ipAddresses?: { nodes?: IpNode[] } } };
    errors?: Array<{ message?: string }>;
  } | null;
  return b?.data?.app?.ipAddresses?.nodes ?? [];
}

function extractErrors(body: unknown): string[] {
  const b = body as { errors?: Array<{ message?: string }> } | null;
  return (b?.errors ?? []).map((e) => String(e.message ?? "unknown")).slice(0, 3);
}

export const Route = createFileRoute("/api/public/tmp/fly-ipv6")({
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

        // --- Fly operation ---
        const token = process.env["FLY_API_TOKEN"];
        if (!token) {
          return Response.json({ ok: false, error: "token_not_available" }, { status: 500 });
        }

        const report: Record<string, unknown> = { ok: true, steps: [] as string[] };
        const steps = report["steps"] as string[];

        // 1) List current IPs (GraphQL — same call as `fly ips list`)
        const before = await gql(token, LIST_QUERY, { name: APP });
        if (before.status !== 200) {
          return Response.json(
            { ok: false, error: `fly_gql_http_${before.status}` },
            { status: 502 },
          );
        }
        const beforeErrs = extractErrors(before.body);
        if (beforeErrs.length > 0) {
          return Response.json(
            { ok: false, error: "fly_gql_error", detail: beforeErrs },
            { status: 502 },
          );
        }
        const ipsBefore = extractIps(before.body);
        report["ips_before"] = ipsBefore;

        const hasV6 = ipsBefore.some((i) =>
          String(i.type ?? "").toLowerCase().includes("v6"),
        );

        // 2) Allocate public IPv6 if absent (idempotent)
        if (!hasV6) {
          const alloc = await gql(token, ALLOCATE_V6, {
            input: { appId: APP, type: "v6" },
          });
          const allocErrs = extractErrors(alloc.body);
          if (alloc.status !== 200 || allocErrs.length > 0) {
            return Response.json(
              {
                ok: false,
                error: allocErrs.length > 0 ? "fly_allocate_error" : `fly_gql_http_${alloc.status}`,
                detail: allocErrs,
                ips_before: ipsBefore,
              },
              { status: 502 },
            );
          }
          steps.push("ipv6_allocated");
        } else {
          steps.push("ipv6_already_present");
        }

        // 3) Verify: list IPs after
        const after = await gql(token, LIST_QUERY, { name: APP });
        report["ips_after"] = extractIps(after.body);

        // 4) Machines/region via Machines API (best effort)
        const machines = await fetch(`${FLY_API}/apps/${APP}/machines`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        report["machines_status"] = machines.status;
        if (machines.ok) {
          const list = (await machines.json()) as Array<Record<string, unknown>>;
          report["machines"] = list.map((m) => ({
            id: m["id"],
            state: m["state"],
            region: m["region"],
          }));
        }

        return Response.json(report);
      },
    },
  },
});
