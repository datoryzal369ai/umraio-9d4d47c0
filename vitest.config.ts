// Plain-object config: vitest is resolved ephemerally via `bunx vitest run`,
// so this file must not import from "vitest/config" at evaluation time.
export default {
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    restoreMocks: false,
    testTimeout: 20000,
    hookTimeout: 20000,
    // Tests must be deterministic regardless of ambient server/shell secrets:
    // scrub provider/cron env so suites asserting defaults cannot be polluted.
    env: {
      VOICE_TTS_ENGINE: undefined,
      MINIMAX_TTS_API_KEY: undefined,
      MINIMAX_TTS_VOICE_ID: undefined,
      MINIMAX_TTS_MODEL: undefined,
      MINIMAX_TTS_CONTAINER: undefined,
      MINIMAX_TTS_GROUP_ID: undefined,
      MINIMAX_API_KEY: undefined,
      XIAOZHI_TTS_URL: undefined,
      XIAOZHI_TTS_API_KEY: undefined,
      AI_PROVIDER: undefined,
      CRON_SECRET: undefined,
    },
  },
};
