# WhatsApp inbound drop — diagnosis and minimum safe fix

## What the live logs show (published site, 23 Aug 2026)

Mahadhir's two controlled texts (00:33:02.546Z and 00:33:10.515Z) DID reach production and passed every early stage:

- Request reached `POST https://umraio.com/api/public/whatsapp` → 200
- `webhook_signature_valid=true`
- `phone_number_id=1232996883231810` present and correct
- `type=text messages=1` — a genuine inbound message, not a status callback

They then hit the newly published diagnostic branch:

```text
[whatsapp] inbound_dropped reason=missing_sender
  phone_number_id=1232996883231810
  provider_message_id=wamid.HBgTTVkuMTA0MzEwMjEyMTk2MjE3OB...
  message_type=text from_present=false
```

For contrast, the owner's own text at 00:33:53 passed the same gate, reached `agency identified`, generated a reply and sent it successfully at 00:34:13. So config resolution, persistence, `auto_reply`, `ai_enabled`, access token, quota and outbound send are all healthy. Nothing downstream is broken.

## Root cause (confirmed)

The failing branch is the sender guard in `src/routes/api/public/whatsapp.ts` (the `if (!from)` return, around lines 88–93). `classifyInboundMessage` reads only `messages[0].from`, and for Mahadhir's messages that field is absent.

Decoding the `wamid` shows the sender identity Meta attached is `MY.1043102121962178` — not an E.164 phone number. This is Meta's newer privacy/identity form (LID / username-style sender identity) rather than the classic `from: "60176927864"`. Messages carrying that identity arrive without the phone in `from`, so UMRAIO drops them before any tenant work — correctly returning 200 so Meta does not retry-storm, which is why it looked silent.

This is a production blocker for any sender whose account presents this identity form.

## Step 1 — observability correction (safe, needed to pin the exact field)

The logs prove `from` is missing, but not which field DOES carry the identity. One observability-only change, no behaviour change:

- In the `missing_sender` branch, log the **key names present** on `value.contacts[0]` and `messages[0]` (e.g. `contact_keys=wa_id,profile message_keys=id,type,text,...`) plus booleans such as `has_wa_id`, `has_sender_identity`. Log key names and presence booleans only — never the identity values themselves.

That single line on the next inbound from Mahadhir names the exact field to read.

## Step 2 — functional fix (NOT implemented until you approve)

Once the field is named, the minimum safe fix is a **sender-resolution fallback only**:

- In `classifyInboundMessage` (or at the route's sender resolution), when `messages[0].from` is empty, fall back in order to `value.contacts[0].wa_id`, then whatever identity field Step 1 reveals.
- Everything downstream stays byte-identical: the resolved identity continues to be used as the lead `phone` / conversation `external_id`, so tenant isolation, idempotency, coalescing and quota logic are untouched.

Consideration to confirm with you before implementing: if the identity is a LID rather than a phone number, the resulting lead will be keyed on that identity instead of `60176927864`, and outbound replies address the LID. That is how Meta expects it to work, but it means such leads won't auto-merge with an existing phone-keyed lead for the same person. No merge logic is in scope here.

## Out of scope

No changes to Meta/WABA settings, AI logic, outbound sending, quota, schema, or sender-eligibility rules.
