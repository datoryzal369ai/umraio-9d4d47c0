import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { failed, json, supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "get_lead",
  title: "Get lead details",
  description:
    "Fetch one lead with its recent internal notes and upcoming appointments, by lead id.",
  inputSchema: {
    lead_id: z.string().uuid().describe("The lead's id."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ lead_id }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const supabase = supabaseForUser(ctx);

    const { data: lead, error } = await supabase
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .maybeSingle();
    if (error) return failed(error.message);
    if (!lead) return failed("Lead not found.");

    const [{ data: notes }, { data: appointments }] = await Promise.all([
      supabase
        .from("lead_notes")
        .select("id, body, created_at")
        .eq("lead_id", lead_id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("appointments")
        .select("id, title, start_at, end_at, status, timezone, notes")
        .eq("lead_id", lead_id)
        .order("start_at", { ascending: true })
        .limit(10),
    ]);

    return json({ lead, notes: notes ?? [], appointments: appointments ?? [] });
  },
});
