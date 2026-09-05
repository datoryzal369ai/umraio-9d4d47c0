import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { failed, json, supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "list_conversation_messages",
  title: "Read a conversation",
  description:
    "Read the recent WhatsApp conversation messages for a lead, oldest to newest, so you can summarise what was discussed.",
  inputSchema: {
    lead_id: z.string().uuid().describe("The lead whose conversation should be read."),
    limit: z.number().int().min(1).max(100).default(30).describe("How many messages to return."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ lead_id, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const supabase = supabaseForUser(ctx);

    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, channel, status, conversation_state, last_message_at, human_attention_required")
      .eq("lead_id", lead_id)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (convError) return failed(convError.message);
    if (!conversation) return json({ conversation: null, messages: [] });

    const { data: messages, error } = await supabase
      .from("messages")
      .select("id, sender, body, modality, delivery_status, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(limit ?? 30);
    if (error) return failed(error.message);

    return json({ conversation, messages: (messages ?? []).slice().reverse() });
  },
});
