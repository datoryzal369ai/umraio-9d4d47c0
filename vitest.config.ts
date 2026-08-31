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
  },
};
