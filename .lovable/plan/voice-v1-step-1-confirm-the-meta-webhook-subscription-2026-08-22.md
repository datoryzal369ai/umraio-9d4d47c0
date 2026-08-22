# Voice V1 — Step 1: Confirm the Meta webhook subscription

Goal of this step: prove, before any live voice note is sent, that Meta is delivering webhook events for the UMRAX number to the live UMRAIO endpoint. No code, config, database or UI changes.

## What the data already tells us

A read-only check of the backend shows inbound WhatsApp traffic from the UMRAX number arriving as recently as today at 05:54 UTC — 528 stored messages in total, all text. That means:

- the webhook URL currently configured in Meta reaches the live UMRAIO endpoint,
- the `messages` field is subscribed (text notifications are delivered under that same field),
- the HMAC app-secret check passes, and the number resolves to the UMRAX agency.

Voice notes arrive on the exact same `messages` subscription — Meta has no separate "audio" field. So no additional subscription is needed; what remains is confirming the console still points where we think it does, and that nothing was changed since the last inbound.

## Checks to perform in the Meta app (device/console side — cannot be done from code)

1. WhatsApp → Configuration → Webhook: confirm the callback URL is the UMRAIO production endpoint
   `https://project--34af2e6d-598c-48a2-a52d-f7cca0cbb051.lovable.app/api/public/whatsapp`
   (`https://umraio.com/api/public/whatsapp` also serves it).
2. Confirm the webhook status shows as verified — the verify token is stored per-agency in the backend, not in an environment variable, and the stored value for UMRAX is present.
3. Under "Webhook fields", confirm `messages` is subscribed. Nothing else is required for voice.
4. Confirm the phone number in use is the one whose Meta phone number id is `1232996883231810` (the UMRAX business number). The second stored connection ("umraverse Agency") holds a display-formatted number with no access token and can never match a real payload — do not test with it.
5. Confirm the app is Live (not in development mode with the test number), and that the access token stored for UMRAX has not expired — an expired token still passes signature checks but fails media download.

## Verification I run afterwards (read-only, from my side)

- Ask you to send one ordinary text message from a real phone, then confirm a new `messages` row and a fresh `last_inbound_at` timestamp appear for the UMRAX agency, plus a matching AI reply row. That single round trip proves subscription, signature, tenant resolution, persistence and outbound delivery in one shot.
- If nothing appears: the discriminator is whether the signature log line shows a valid or invalid signature — invalid means the app secret no longer matches the app; nothing at all means the subscription or URL is wrong.

## What happens after this step

Only once the text round trip is confirmed do we proceed to the live voice note (10–20 s, Malay or mixed), and I read the voice-stage telemetry and the audio/usage rows to prove media retrieval, transcription, pipeline entry and metering. That is a separate step and nothing is implemented in either.
