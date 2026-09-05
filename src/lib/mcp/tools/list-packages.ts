import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { failed, json, supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "list_packages",
  title: "List Umrah packages",
  description: "List the agency's Umrah packages with pricing, hotels, airline and inclusions.",
  inputSchema: {
    active_only: z.boolean().default(true).describe("Only return packages currently on sale."),
    limit: z.number().int().min(1).max(100).default(25).describe("How many packages to return."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ active_only, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    let query = supabaseForUser(ctx)
      .from("packages")
      .select(
        "id, name, price_myr, nights, star_rating, airline, hotel_makkah, hotel_madinah, departure_date, inclusions, is_active",
      )
      .order("price_myr", { ascending: true })
      .limit(limit ?? 25);
    if (active_only !== false) query = query.eq("is_active", true);

    const { data, error } = await query;
    if (error) return failed(error.message);
    return json({ packages: data ?? [], count: data?.length ?? 0 });
  },
});
