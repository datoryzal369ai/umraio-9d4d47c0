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
    // Determinism: tests/setup-env.ts deletes ambient provider/cron secrets
    // the shell exports, so suites asserting defaults cannot be polluted.
    setupFiles: ["tests/setup-env.ts"],
  },
};
