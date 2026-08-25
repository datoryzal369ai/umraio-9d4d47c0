/**
 * CONSOLE OUTBOUND TEXT (pure core).
 *
 * Browser-safe validation shared by the console UI and the server function.
 * No credentials, no network. The server always re-runs these checks.
 */

export const MAX_OUTBOUND_TEXT_CHARS = 4000;

export type OutboundTextAuthorization =
  | { ok: true; to: string; body: string; agencyId: string }
  | { ok: false; message: string };

export function authorizeOutboundText(input: {
  conversation: { id: string; agency_id: string; lead?: { phone?: string | null } | null } | null;
  body: string | null | undefined;
}): OutboundTextAuthorization {
  if (!input.conversation) {
    return { ok: false, message: "Conversation not found for this account." };
  }
  const to = (input.conversation.lead?.phone ?? "").trim();
  if (!to) return { ok: false, message: "This contact has no WhatsApp number." };
  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, message: "Type a message before sending." };
  if (body.length > MAX_OUTBOUND_TEXT_CHARS) {
    return { ok: false, message: "This message is too long for WhatsApp." };
  }
  return { ok: true, to, body, agencyId: input.conversation.agency_id };
}
