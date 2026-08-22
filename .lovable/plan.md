# UMRAIO® Voice V1 — Live E2E Validation Gate (read-only audit + test runbook)

No files, secrets, database rows, routing or UI were changed. Findings below come from code reads, environment checks and read-only database queries run just now.

## 1. Webhook endpoint and verification

- Endpoint: `POST /api/public/whatsapp` (file `src/routes/api/public/whatsapp.ts`). Public prefix, so Meta reaches it without site auth.
  - Preview: `https://project--34af2e6d-598c-48a2-a52d-f7cca0cbb051-dev.lovable.app/api/public/whatsapp`
  - Production: `https://project--34af2e6d-598c-48a2-a52d-f7cca0cbb051.lovable.app/api/public/whatsapp` (also reachable on `umraio.com`)
- `GET` handshake: requires `hub.mode=subscribe` plus `hub.verify_token` matching a `verify_token` value stored in `whatsapp_configs`. There is no env-var verify token; the token lives per-tenant in the database. (`WHATSAPP_VERIFY_TOKEN` is absent from the environment and is not used by this code — not a blocker.)
- `POST` security: raw body → HMAC SHA-256 via `verifyMetaSignature` against `META_APP_SECRET` → 401 on mismatch before any DB/AI/Meta work.
- Tenant resolution: `whatsapp_configs.phone_number_id` must equal Meta's `metadata.phone_number_id`. No match → logs an error and returns 200 (so Meta does not disable the subscription).
- Idempotency: `messages(agency_id, provider_message_id)` fast-path check plus a unique index, both ahead of media retrieval, ASR and LLM.

## 2. Meta credentials/config — current state

| Item | Required for live voice | Status |
|---|---|---|
| `META_APP_SECRET` | Yes (HMAC) | Present |
| `LOVABLE_API_KEY` | Yes (ASR) | Present |
| `whatsapp_configs.access_token` | Yes (media download + reply send) | Present for UMRAX TRAVEL AGENCY (`phone_number_id 1232996883231810`) |
| `whatsapp_configs.verify_token` | Yes (GET handshake) | Present for both rows |
| `auto_reply` | Yes | true |
| Webhook subscribed to `messages` field in Meta App | Yes | Cannot be verified from code — must be confirmed in the Meta app |

The second row ("umraverse Agency") has `phone_number_id = "016-755 9991"` and no access token — that row can never match a real Meta payload and cannot be used for the test. Use the UMRAX row.

Live traffic already exists on the UMRAX number: 528 text messages, latest inbound `2026-08-22 05:54`, so signature, tenant resolution, persistence and the reply path are proven live for text.

## 3. ASR provider and gateway configuration

- Model `openai/gpt-4o-transcribe`, endpoint `https://ai.gateway.lovable.dev/v1/audio/transcriptions`, multipart upload, `Authorization: Bearer LOVABLE_API_KEY` (`src/lib/voice/asr.server.ts`).
- No `language` parameter — auto-detect, so Malay / English / mixed all transcribe as spoken.
- Terminal statuses (400/404 → invalid audio, 401 → config, 402/403 → entitlement) are never retried; 429/5xx get 3 bounded attempts.
- Media retrieval: Graph `v21.0` metadata then binary download with the agency token (`src/lib/voice/media.server.ts`); size gate at 10 MB, duration gate at 30 s (estimated at ~2000 bytes/s pre-ASR, corrected from the ASR-reported duration afterwards).
- Not yet proven: a real gateway transcription call has never run in production — only mocked in tests. This is the single largest unknown and only a real audio payload settles it.

## 4. Voice quota prerequisites

- `assertVoiceQuota` runs before media download and before ASR, and fails closed if metering is unavailable.
- UMRAX agency plan = `trial` → `voiceMinutesPerMonth: 15`.
- Current voice usage this month: zero `voice_transcription` rows, so the full 15 minutes is available. A 10–20 s test note consumes 1 minute.
- Successful transcriptions meter `duration_seconds`; failures are recorded with `success: false` and are not charged as successful.

## 5. Exact live test sequence

1. Confirm in the Meta app that the WhatsApp `messages` webhook is subscribed and points at the production URL above (device/Meta-console step).
2. From a real phone that is not the business number, send the UMRAX number a **text** message first ("Salam, nak tanya pakej umrah") to re-confirm the baseline path is healthy today.
3. Send a **voice note of 10–20 seconds** in Malay or mixed Malay-English with a clear Umrah enquiry (e.g. name, 4 pax, March intake, budget).
4. Expect: no second AI reply for the text if sent within the coalescing window; for the voice note a single WhatsApp reply from RAIŌ answering the spoken content within roughly 10–25 s (3.5 s audio coalescing window + media + ASR + model).
5. Negative case (optional, same session): send a voice note longer than 30 s → expect the honest Malay "too long" fallback, no AI answer.

## 6. Telemetry that proves each stage

Server logs (in order) for one successful note:

```text
[whatsapp] webhook_signature_valid=true
[whatsapp] webhook received phone_number_id=1232996883231810 type=audio
[whatsapp] agency identified agency_id=efaa961f-...
[voice] audio_received ... media_id=...
[voice] quota_decision=allowed
[voice] media_retrieval=ok bytes=... mime=audio/ogg
[voice] audio_duration_estimate_s=...
[voice] asr_started model=openai/gpt-4o-transcribe
[voice] asr_success chars=... duration_s=... latency_ms=...
[voice] transcript_pipeline_entry total_latency_ms=...
```

Database proof after the test:

- `select modality, media_id, body from messages where agency_id='efaa961f-...' and modality='audio' order by created_at desc limit 5;` — inbound row must be `modality='audio'` with the Meta media id and the transcript as `body`.
- the following `sender='ai'` row must be `modality='text'`.
- `select category, success, duration_seconds from usage_events where counts_against='voice_minutes' order by occurred_at desc limit 5;` — one row, `success=true`, real duration.
- `activity_log` carries an inbound entry; a failed note instead writes "Voice note could not be processed" with the reason.

Note: today there are zero `audio` rows and zero voice usage events, so any row appearing after the test is unambiguous evidence.

## 7. Blockers

No P0 code or configuration blocker was found for a single live test. Open risks, in order:

1. **Meta webhook subscription for the `messages` field cannot be verified from here.** If it is not subscribed (or points at an old URL), nothing arrives. Device/console verification required.
2. **The gateway ASR call is unproven in production.** A 401/402/404 from the transcriptions endpoint would surface as the generic Malay fallback; the `[voice] asr_failure category=...` log line is the discriminator.
3. **Trial voice allowance is 15 minutes/month** — fine for testing, needs raising before a pilot with real volume.
4. Stale `whatsapp_configs` row for "umraverse Agency" (`phone_number_id` holds a display number, no token). Harmless for the test, but it should be cleaned up before onboarding real agencies.

### Verifiable from code/config vs. requires a real device

- From code/config (all done above): endpoint, HMAC, verify-token model, tenant row, token presence, ASR wiring, quota headroom, telemetry lines, DB assertions.
- Requires a real WhatsApp device / Meta number: webhook subscription state, actual Opus payload retrieval, real transcription quality, end-to-end latency, and the delivered reply.

## Proposed next action (no implementation in this task)

Run the live test as sequenced in section 5, then return here with the observed log lines. Nothing is changed until those logs identify a real failure.
