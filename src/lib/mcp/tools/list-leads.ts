import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { failed, json, supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "list_leads",
  title: "List leads",
  description:
    "List the agency's Umrah leads, newest first. Optionally filter by stage, temperature or a name/phone/email search.",
  inputSchema: {
    search: z.string().trim().min(1).optional().describe("Match on name, phone or email."),
    stage: z.string().trim().min(1).optional().describe("Lead stage, e.g. new or qualified."),
    temperature: z.string().trim().min(1).optional().describe("Lead temperature, e.g. hot."),
    limit: z.number().int().min(1).max(100).default(20).describe("How many leads to return."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ search, stage, temperature, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    let query = supabaseForUser(ctx)
      .from("leads")
      .select(
        "id, full_name, phone, email, stage, temperature, score, pax, budget_myr, preferred_month, package_interest, source, do_not_contact, last_contact_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);

    if (stage) query = query.eq("stage", stage);
    if (temperature) query = query.eq("temperature", temperature);
    if (search) {
      const term = `%${search}%`;
      query = query.or(`full_name.ilike.${term},phone.ilike.${term},email.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) return failed(error.message);
    return json({ leads: data ?? [], count: data?.length ?? 0 });
  },
});
