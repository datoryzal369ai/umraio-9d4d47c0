/**
 * Vitest setup (runs in every isolated worker before test files).
 *
 * The sandbox/CI shell exports live provider and cron configuration
 * (VOICE_TTS_ENGINE, MINIMAX_*, AI_PROVIDER, CRON_SECRET, ...). Suites that
 * assert default behaviour must not observe those ambient values, so they are
 * deleted here — genuine `delete`, since config-level env scrubbing would
 * only coerce them to the string "undefined".
 *
 * Test-only: no production code is touched and individual tests remain free
 * to set any of these variables explicitly.
 */
const AMBIENT_SERVER_VARS = [
  "VOICE_TTS_ENGINE",
  "MINIMAX_TTS_API_KEY",
  "MINIMAX_TTS_VOICE_ID",
  "MINIMAX_TTS_MODEL",
  "MINIMAX_TTS_CONTAINER",
  "MINIMAX_TTS_GROUP_ID",
  "MINIMAX_API_KEY",
  "XIAOZHI_TTS_URL",
  "XIAOZHI_TTS_API_KEY",
  "AI_PROVIDER",
  "CRON_SECRET",
] as const;

for (const key of AMBIENT_SERVER_VARS) {
  delete process.env[key];
}
