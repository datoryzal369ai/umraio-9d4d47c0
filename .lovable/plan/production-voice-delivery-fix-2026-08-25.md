# Production voice delivery fix

## Scope
- Preserve existing text, image, document, DNC, webhook ingestion, billing, and onboarding behavior.
- Harden only outbound recorded audio and outbound WhatsApp delivery-status reconciliation.

## Implementation
1. Validate the real recorded bytes before upload, not only the declared MIME:
   - accept OGG only when it contains Opus audio;
   - accept MP4/M4A only when it contains AAC (`mp4a`), rejecting MP4-wrapped Opus or unknown codecs;
   - retain matching MIME and filename values in the Meta upload.
2. Remove the unsafe assumption that every browser `audio/mp4` recording is WhatsApp-compatible. Show a clear pre-upload error for unsupported output while preserving image/document behavior.
3. Process Meta `statuses[]` webhook events independently from inbound `messages[]`:
   - match the exact `wamid` to `messages.provider_message_id`;
   - persist `sent`, `delivered`, `read`, or `failed` without allowing status regression;
   - log sanitized failure code/title/details and terminal outcomes;
   - continue processing batched inbound messages as before.
4. Improve outbound media telemetry with the validated container/codec, media ID, `wamid`, and sanitized Graph result—never credentials or recipient data.
5. Add focused tests for byte/container/codec validation, MP4-wrapped non-AAC refusal, OGG/Opus acceptance, status progression/failure, and unchanged text/image/document payloads.

## Validation
- Run focused outbound and webhook test suites plus TypeScript typecheck.
- Verify the production incident evidence against the fixed logic. No publish/deploy unless explicitly requested.

## Confirmed audit facts
- The latest row was uploaded as `audio/mp4` (39,539 bytes) and Meta returned both media ID and `wamid`.
- The bytes were discarded after upload, so the current system cannot retrospectively prove the actual codec from storage.
- The webhook currently ignores `statuses[]`; therefore a later Meta delivery failure remains falsely displayed as `sent`.
- Two console text rows immediately before the voice test still have no provider `wamid`, showing the published deployment does not contain the complete previous console-text patch.
