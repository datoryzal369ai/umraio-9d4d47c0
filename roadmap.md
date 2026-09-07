# UMRAIO® — P0 Safe Repair roadmap (non-media Calling defects)

Authorization: implement + test only. NO merge, NO deploy, NO publish.

## Verified against production DB (read-only, 2026-09)
- `whatsapp_call_sessions_status_check` allows only
  `ringing, answer_requested, media_negotiating, answered, missed, terminated, failed`
  → the `status = "meta_pre_accepted"` update in `calls.server.ts` is rejected and the error is ignored.
- `messages_modality_check` allows only `text, audio, image`;
  `messages_delivery_status_check` allows only `sent, delivered, read, failed, send_failed, not_applicable`
  → `persistCallMemory` (`modality: "call_summary"`, `delivery_status: "internal"`) is rejected and swallowed.

## Ready items
- [ ] 1a. Compatibility migration (widening only): add `meta_pre_accepted` to call-session status check;
      add `call_summary` to messages modality check and `internal` to delivery-status check.
- [ ] 1b. `call-context.server.ts`: surface DB errors from persist/finalize (log + return outcome), never throw into call path.
- [ ] 1c. `calls.server.ts`: check `.error` on pre-accept / accept / callback / notify persistence writes; log observably.
- [ ] 1d. `media.core.ts` `mediaKindOf`: treat `call_summary` as text so the row renders as a normal bubble, not "Media received".
- [ ] 2a. `meta-calls.server.ts`: add `terminate` action (no SDP body) + `metaTerminateCall`; `isGracefulCompletion` (`conversation_complete`).
- [ ] 2b. `calls.server.ts` `processGatewayCallback`: best-effort duplicate-safe Meta terminate after `conversation_complete`
      using tenant credentials from `whatsapp_configs` (select `agency_id, phone_number_id` on the session row).
- [ ] 2c. `engine.go`: `Disconnected` recoverable (log only); `Failed → ice_failed`; `Closed → peer_closed`; `IsTerminalPeerState`.
- [ ] 3.  `conversation.go`: completion-triggered `Transport.Terminate` must run outside the tracked turn goroutine
      (async, once-guarded); `Close` must not self-wait.
- [ ] 4a. `call-timings.core.ts`: first-write-wins for stage marks (`mark` + `mergeCallTimings`); keep failure_reason precedence.
- [ ] 4b. `media-gateway.server.ts` `notifyCallAccepted`: return `ok` only on confirmed `greeting ∈ {started, already_started}`.
- [ ] 4c. `conversation.go` / `api/server.go`: `media_ready` callback delivery result telemetry; `engine.go` separate
      ICE / DTLS / RTP / outbound-ready structured log fields (no SDP, no IPs, no credentials, no PII).
- [ ] 5.  Focused tests for every item (Vitest + Go), then full Vitest, tsgo, Vite build, `git diff --check`, Go build/vet/test.
- [ ] 6.  Report A–G; stop before merge/deploy/publish.

## Deferred (not authorized)
- media_ready race repair, PR #4 bundle, MiniMax credentials, TTS/model/voice, RÉNAGI, Stripe, MCP.
