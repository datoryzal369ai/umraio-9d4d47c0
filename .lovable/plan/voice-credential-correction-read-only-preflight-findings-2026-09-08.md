# Voice credential correction — read-only preflight findings

No changes were made: no secret read/written, no synthesis, no WhatsApp traffic, no deployment.

## 1. Published build and TTS precedence
- Published application (checked 2026-09-08 16:30 UTC, HTTP 200): `commit_sha 68cb9f6f85dfe6f8b9d0351f777bf907edbd118f`, `build_time 2026-09-07T13:27:52.730Z`, `environment production`.
- Runtime precedence (source `src/lib/voice/minimax.server.ts`, read at call time inside the handler): `MINIMAX_TTS_API_KEY` first, `MINIMAX_API_KEY` only if the first is absent/blank. Model and voice are compiled constants (`speech-2.8-hd`, `Malay_male_1_v1`); `MINIMAX_TTS_MODEL` / `MINIMAX_TTS_VOICE_ID` are ignored (override attempts are logged as non-secret diagnostics only).

## 2. Presence in the actual published runtime
- Only configured-name metadata is available. The project secret store lists both `MINIMAX_TTS_API_KEY` and `MINIMAX_API_KEY` (names only, values encrypted and never displayed).
- There is no supported read-only facility that reports whether the deployed Worker resolved a non-blank value, which variable it selected, or any class/fingerprint. Non-blankness in the published runtime is UNVERIFIED, and no non-invasive operation exists to verify it.

## 3. Rollback / restore capability for secrets — NOT VERIFIABLE
- No immutable version handle, no version history, no server-side backup or restore operation is exposed for secrets. Available secret operations are: list names, set (create-only for the agent), generate, delete.
- Reverting an application deployment does NOT restore secrets. Secrets are stored outside the app snapshot and are shared by the single backend instance; a code rollback leaves the current secret values in place.
- Consequence: the only recoverable path is that the owner keeps the current value themselves before replacing it. The platform cannot restore a previous secret value. This is the exact missing native operation.

## 4. Secure workflow to set only `MINIMAX_TTS_API_KEY`
- Owner-only, value never passes through chat, model or tool arguments: open the project's Cloud/Backend panel → Secrets → locate `MINIMAX_TTS_API_KEY` → edit → paste the new value into the masked input → save. Existing name is edited in place; no new variable is introduced.
- The agent cannot change the value of an existing secret; only the owner can, through that form.

## 5. Scope and activation of a secret change
- One backend instance serves both preview and production, so a secret change applies to both immediately.
- It takes effect at the next server-function invocation because the key is read inside the handler at call time. No application publication and no source republication is required or triggered; no code redeploy occurs.

## 6. Standalone synthetic TTS without WhatsApp
- No existing production endpoint performs a standalone MiniMax synthesis on demand without a conversation turn. The published surface exposes only the build-health endpoint plus business/webhook routes.
- Therefore, post-change verification with the current published build would require either a real WhatsApp voice turn, or a separately approved minimal change adding an owner-authenticated synthesis probe. No such probe exists today.

## Preconditions before any credential correction
1. Owner independently retains the current `MINIMAX_TTS_API_KEY` value outside the platform (the platform cannot restore it).
2. Owner decides the verification method for item 6 (real WhatsApp turn vs. separately approved probe).
