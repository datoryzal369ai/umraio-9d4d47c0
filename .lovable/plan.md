# Outbound WhatsApp: text and voice not reaching the recipient (audit + surgical fix)

Read-only audit complete. Image is untouched by this plan.

## What the three paths actually do today

| Path | UI | Server | Meta call | Result |
|---|---|---|---|---|
| Image | `MediaComposer` | `sendConversationMedia` | upload `/media` + send `/messages` | works (rows carry a real `wamid`) |
| Document | `MediaComposer` | same | same | works |
| Text | `$conversationId.tsx` `send` mutation | none | **none** | never leaves UMRAIO |
| Voice | `MediaComposer` | `sendConversationMedia` | upload + send | Meta accepts (`wamid` returned) but device does not render it |

## A. Text — confirmed root cause

`src/routes/_authenticated/conversations/$conversationId.tsx:125-149` calls `insertMessage(...)` from
`src/lib/conversations.ts:144-161`, which only does a Supabase `messages` insert. A repo-wide search shows
`sendWhatsappText` is imported only by the inbound webhook, the Islamic review sender and the follow-up dispatcher —
never by any console path. So a console text is written to the timeline and never sent to Meta.

The failure is silent because `messages.delivery_status` defaults to `sent`: production rows for
"Salam dato' rizal", "Boleh", "Hai datuk" etc. all show `delivery_status=sent` with
`provider_message_id = NULL` — the signature of a row that never touched Graph.

## B. Voice — high-confidence cause (Meta accepted, WhatsApp cannot play it)

Row `830a1a03…` (2026-08-25 17:51) is `modality=audio`, `delivery_status=sent`, with a real `wamid`, and the image
sent one minute later to the same recipient did arrive. So the upload and send both succeeded; the media itself is
the problem.

Two defects in the recording path combine:

1. `pickRecordingMime()` (`src/components/conversations/MediaComposer.tsx:45-51`) walks
   `PREFERRED_RECORDING_MIME = ["audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"]`
   (`src/lib/conversations/outbound-media.core.ts`). Chromium does not support OGG recording, so it lands on
   `audio/mp4` (AAC) — or on nothing at all in browsers without MP4 muxing.
2. Whatever container is produced, the blob is uploaded with the hardcoded filename **`voice-note.ogg`**
   (`MediaComposer.tsx` `recorder.onstop`, and again as the server default in
   `src/lib/conversations/outbound-media.functions.ts:105-110`). Meta stores the media by the declared
   `type`/filename pair; an MP4/AAC payload announced as `.ogg` is accepted by the Graph API and then fails to
   render as a playable WhatsApp voice message.

There is also no diagnostic signal: `uploadWhatsappMedia` and `sendWhatsappMediaMessage`
(`src/lib/whatsapp-send.server.ts:105-140, 143-185`) log only `status=`, never the Meta error body.

## Smallest surgical fix

### 1. Text actually sends (new server function, no change to media)

Add `src/lib/conversations/outbound-text.functions.ts`:

- `sendConversationText` — `createServerFn({ method: "POST" })` + `requireSupabaseAuth`, mirroring
  `sendConversationMedia` exactly: RLS-scoped conversation read for ownership → resolve `lead.phone` →
  read `whatsapp_configs` via `supabaseAdmin` **after** ownership → `sendWhatsappText` →
  insert the `messages` row with `sender: "human"`, real `delivery_status` (`sent` / `send_failed`) and the
  returned `provider_message_id` → bump `conversations.last_message_at` → `activity_log` entry.
- `sendWhatsappText` must return the `wamid`; change its return type from `boolean` to
  `{ ok: boolean; providerMessageId: string | null }` and update its three existing callers
  (`whatsapp.ts`, `islamic/review.server.ts`, `followups/dispatcher.server.ts`) to read `.ok` — behaviour unchanged.

In `$conversationId.tsx`, the `send` mutation calls `sendConversationText` when the composer is in
**"replying as human"** mode; the existing "sending as customer" simulation keeps using `insertMessage`
(DB-only) so the AI-reply test flow is preserved.

### 2. Voice becomes a real WhatsApp voice note

- `outbound-media.core.ts`: add `audio/webm` to the recorder-side handling and a
  `filenameForOutboundMime(mime)` helper mapping `audio/ogg→.ogg`, `audio/mp4→.m4a`, `audio/mpeg→.mp3`,
  `audio/aac→.aac`, `audio/amr→.amr`. Reorder `PREFERRED_RECORDING_MIME` to
  `["audio/ogg;codecs=opus", "audio/mp4", "audio/webm;codecs=opus"]`.
- `MediaComposer.tsx`: name the recorded blob from its real mime instead of the hardcoded `voice-note.ogg`.
  If the browser can only produce `audio/webm` (which WhatsApp does not accept), block the send with a clear
  message rather than uploading an unplayable file.
- `outbound-media.functions.ts`: derive the audio upload filename from the validated mime (drop the
  `"voice-note.ogg"` default).
- `whatsapp-send.server.ts`: include the Meta response body in `media_upload_failed` / `media_send_failed`
  logs (Meta error bodies contain no token), so any residual audio rejection is visible next time.

Image and document sends keep their current mime, filename and payload construction untouched.

### 3. Truth in the timeline

Backfill is not proposed. Going forward, every console send persists the delivery result it actually got, so a
row with `delivery_status=sent` and no `provider_message_id` can no longer exist.

## Tests

- new `tests/console-outbound-text.test.ts`: ownership rejection, `send_failed` persistence on Meta failure,
  `wamid` persisted on success, customer-simulation mode never calls Meta.
- extend `tests/conversation-outbound-media-b44.test.ts`: audio filename follows the mime; `audio/webm` is refused;
  image path assertions unchanged (regression guard).
