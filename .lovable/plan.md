# Voice E2E V2.5.1 — turn-scoped review fix

## Scope
- Do not change Islamic classification, review state transitions, billing/quota, STT/TTS engines, language, security, or authentication.
- Do not publish.

## Root cause to correct
The active webhook still contains a pre-AI `pending_review_loop_breaker`. It queries the latest open review for the conversation and can return the exact holding message before sales AI and the voice pipeline run. Timestamp comparison is not a reliable turn identity under concurrent/coalesced processing, so an older review can be mistaken for the current voice turn.

## Implementation
1. Remove the pre-AI holding/acknowledgement early-return block from the WhatsApp webhook. A prior open review will remain in the review queue but cannot intercept a new inbound turn.
2. Keep one shared `findCurrentTurnOpenReview()` check after AI generation for both text and voice semantics. Current HIGH_RISK generation may create a review; the post-generation check suppresses voice only for that current turn.
3. Add the requested structured trace markers without logging customer identity:
   - `VOICE_INBOUND_START` with conversation/message/timestamp/transcript
   - detailed `ISLAMIC_REVIEW_LOOKUP` and `ISLAMIC_REVIEW_RESULT` including review ID, creation time, status, previous-review/current-turn flags, and action
   - `VOICE_ELIGIBILITY`, TTS, send, and completion markers
4. Keep text-first delivery unchanged. Current HIGH_RISK receives its generated holding text and review; normal sales/basic/guidance voice proceeds to TTS and audio send.

## Regression validation
- Add route-level regression coverage for an existing PENDING review followed by each voice transcript:
  - “Saya nak tanya pasal pakej Umrah 12 hari.” → normal sales text + voice/TTS, no holding/new review.
  - “Berapa harga pakej?” → text + voice/TTS, no holding/new review.
  - “Apa maksud Talbiyah?” → BASIC answer + voice/TTS, no holding/new review.
  - Current HIGH_RISK voice → review created, holding text allowed, voice suppressed.
- Run the focused Islamic/WhatsApp voice suites.
- Execute the mandatory same-conversation Preview E2E and verify logs plus actual outbound audio for each required turn. If a real inbound WhatsApp voice note cannot be initiated from available tooling, report that limitation rather than claiming success.
