import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { failed, json, supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "add_lead_note",
  title: "Add an internal lead note",
  description:
    "Add an internal note to a lead. Notes are visible to the agency team only and are never sent to the customer.",
  inputSchema: {
    lead_id: z.string().uuid().describe("The lead to attach the note to."),
    body: z.string().trim().min(1).max(4000).describe("The note text."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async ({ lead_id, body }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const supabase = supabaseForUser(ctx);

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, agency_id")
      .eq("id", lead_id)
      .maybeSingle();
    if (leadError) return failed(leadError.message);
    if (!lead) return failed("Lead not found.");

    const { data, error } = await supabase
      .from("lead_notes")
      .insert({
        lead_id,
        agency_id: lead.agency_id,
        author_id: ctx.getUserId(),
        body,
      })
      .select("id, body, created_at")
      .maybeSingle();
    if (error) return failed(error.message);
    return json({ note: data });
  },
});
