import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { failed, json, supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "list_bookings",
  title: "List bookings",
  description:
    "List the agency's Umrah bookings with amounts, deposit status and pax, newest first.",
  inputSchema: {
    status: z.string().trim().min(1).optional().describe("Filter by booking status."),
    limit: z.number().int().min(1).max(100).default(25).describe("How many bookings to return."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ status, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    let query = supabaseForUser(ctx)
      .from("bookings")
      .select(
        "id, lead_id, package_id, status, pax, amount_myr, deposit_amount_myr, deposit_paid, balance_myr, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit ?? 25);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return failed(error.message);
    return json({ bookings: data ?? [], count: data?.length ?? 0 });
  },
});
