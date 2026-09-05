import { auth, defineMcp } from "@lovable.dev/mcp-js";

import addLeadNote from "./tools/add-lead-note";
import getLead from "./tools/get-lead";
import listBookings from "./tools/list-bookings";
import listConversationMessages from "./tools/list-conversation-messages";
import listLeads from "./tools/list-leads";
import listPackages from "./tools/list-packages";

// The OAuth issuer must be the direct Supabase host; the project ref is the only
// value that survives publish unchanged.
const projectRef = import.meta.env["VITE_SUPABASE_PROJECT_ID"] ?? "project-ref-unset";

export default defineMcp({
  name: "umraio-autonomous-a-i",
  title: "UMRAIO Autonomous A.I",
  version: "0.1.0",
  instructions:
    "Tools for UMRAIO, an AI sales workspace for licensed Umrah agencies. Use `list_leads` and `get_lead` to look up customers, `list_conversation_messages` to read what was discussed on WhatsApp, `list_packages` and `list_bookings` for commercial data, and `add_lead_note` to leave an internal note for the team. All tools act as the signed-in agency user and only return that agency's data.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    listLeads,
    getLead,
    listConversationMessages,
    listPackages,
    listBookings,
    addLeadNote,
  ],
});
