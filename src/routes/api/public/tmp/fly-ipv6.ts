import { createFileRoute } from "@tanstack/react-router";

/**
 * TEMPORARY — one-shot infrastructure operation (deleted immediately after use).
 *
 * Allocates a public IPv6 for the existing Fly.io app umraio-voice-gateway
 * using the FLY_API_TOKEN env secret, verifies app state, and returns a
 * sanitized report. The token is read only from the environment and is never
 * logged, returned, or persisted.
 *
 * Caller verification: a valid platform-owner Supabase bearer token.
 */

const FLY_API = "https://api.machines.dev/v1";
const APP = "umraio-voice-gateway";

function fly(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${FLY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
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

        // 0) App visibility probe (distinguishes 404 causes)
        const appProbe = await fly(token, `/apps/${APP}`);
        report["app_probe_status"] = appProbe.status;
        if (appProbe.ok) {
          const a = (await appProbe.json()) as Record<string, unknown>;
          report["app"] = { name: a["name"], status: a["status"], network: a["network"] };
        }

        // 1) Current IPs
        const listBefore = await fly(token, `/apps/${APP}/ips`);
        if (!listBefore.ok) {
          const detail = await listBefore.text().catch(() => "");
          return Response.json(
            {
              ok: false,
              error: `list_ips_http_${listBefore.status}`,
              detail: detail.slice(0, 300),
              app_probe_status: report["app_probe_status"],
            },
            { status: 502 },
          );
        }
        const before = (await listBefore.json()) as Array<Record<string, unknown>>;
        report["ips_before"] = before.map((i) => ({
          id: i["id"],
          type: i["type"],
          address: i["address"],
          region: i["region"],
        }));

        const hasV6 = before.some((i) => String(i["type"]).toLowerCase().includes("v6"));

        // 2) Allocate public IPv6 if absent (idempotent)
        if (!hasV6) {
          const alloc = await fly(token, `/apps/${APP}/ips`, {
            method: "POST",
            body: JSON.stringify({ type: "v6" }),
          });
          if (!alloc.ok) {
            const body = await alloc.text().catch(() => "");
            return Response.json(
              {
                ok: false,
                error: `allocate_v6_http_${alloc.status}`,
                detail: body.slice(0, 300),
                ips_before: report["ips_before"],
              },
              { status: 502 },
            );
          }
          steps.push("ipv6_allocated");
        } else {
          steps.push("ipv6_already_present");
        }

        // 3) Verify: list IPs after
        const listAfter = await fly(token, `/apps/${APP}/ips`);
        const after = listAfter.ok
          ? ((await listAfter.json()) as Array<Record<string, unknown>>)
          : [];
        report["ips_after"] = after.map((i) => ({
          id: i["id"],
          type: i["type"],
          address: i["address"],
          region: i["region"],
        }));

        // 4) Verify machines/region
        const machines = await fly(token, `/apps/${APP}/machines`);
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
