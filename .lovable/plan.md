# MiniMax TTS Runtime Secret Configuration

## Current state (confirmed)
- `VOICE_TTS_ENGINE=minimax` is configured as a runtime secret.
- `MINIMAX_TTS_API_KEY` is NOT configured.
- `MINIMAX_API_KEY` exists as a fallback, but the recent MiniMax config patch prefers `MINIMAX_TTS_API_KEY` when present.

## Action required
1. Open **Cloud → Secrets** in the Lovable editor.
   - Desktop: left sidebar navigation → **More** → **Cloud** → **Secrets**, or command palette → "Secrets".
   - Mobile: Chat mode → bottom-right `...` → **Cloud** → **Secrets**.
2. Click **Add secret**.
3. Enter name: `MINIMAX_TTS_API_KEY`.
4. Paste the MiniMax API key into the value field.
5. Save.

## Constraints
- No code, schema, RLS, deployment, or UI changes.
- The API key must NOT be pasted into this chat or stored in source code.
- Once saved, the existing `minimax.server.ts` logic will automatically prefer `MINIMAX_TTS_API_KEY` over `MINIMAX_API_KEY`.

## Verification after entry
- `MINIMAX_TTS_API_KEY` will appear in the runtime secrets list.
- The MiniMax TTS engine will be active for `VOICE_TTS_ENGINE=minimax`.
