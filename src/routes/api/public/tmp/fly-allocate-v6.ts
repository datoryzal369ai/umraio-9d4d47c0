import { createFileRoute } from "@tanstack/react-router";

/**
 * TEMPORARY — one-shot public IPv6 allocation for the voice gateway.
 * Equivalent to: fly ips allocate-v6 -a umraio-voice-gateway
 *
 * The token is read only from the environment and is never logged or returned.
 * Caller verification: a valid platform-owner Supabase bearer token.
 */

const FLY_GQL = "https://api.fly.io/graphql";
const APP = "umraio-voice-gateway";

async function gql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(FLY_GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

function errs(body: any): string[] {
  return (body?.errors ?? []).map((e: any) => String(e?.message ?? "unknown")).slice(0, 3);
}

const IP_LIST = `query($name: String!) {
  app(name: $name) {
    id
    name
    ipAddresses { nodes { id address type region } }
  }
}`;

export const Route = createFileRoute("/api/public/tmp/fly-allocate-v6")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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

        const token = process.env["FLY_API_TOKEN"];
        if (!token) return Response.json({ error: "token_not_available" }, { status: 500 });

        // 1) Resolve app + existing IPs
        const before = await gql(token, IP_LIST, { name: APP });
        const beforeErrs = errs(before.body);
        const appId = before.body?.data?.app?.id;
        if (!appId) {
          return Response.json(
            { step: "resolve_app", status: before.status, errors: beforeErrs },
            { status: 502 },
          );
        }
        const beforeIps = before.body.data.app.ipAddresses?.nodes ?? [];
        const existingV6 = beforeIps.find((i: any) => i.type === "v6");

        let allocation: any = null;
        let allocationErrors: string[] = [];
        if (!existingV6) {
          const mutation = `mutation($input: AllocateIPAddressInput!) {
            allocateIpAddress(input: $input) {
              ipAddress { id address type region }
            }
          }`;
          const alloc = await gql(token, mutation, {
            input: { appId, type: "v6" },
          });
          allocationErrors = errs(alloc.body);
          allocation = alloc.body?.data?.allocateIpAddress?.ipAddress ?? null;
          if (!allocation) {
            return Response.json(
              { step: "allocate", status: alloc.status, errors: allocationErrors },
              { status: 502 },
            );
          }
        }

        // 2) Re-list IPs after allocation
        const after = await gql(token, IP_LIST, { name: APP });
        const afterIps = (after.body?.data?.app?.ipAddresses?.nodes ?? []).map((i: any) => ({
          address: i.address,
          type: i.type,
          region: i.region,
        }));

        return Response.json({
          app: APP,
          already_had_v6: Boolean(existingV6),
          allocated: allocation ? { address: allocation.address, type: allocation.type, region: allocation.region } : null,
          ip_addresses: afterIps,
        });
      },
    },
  },
});
