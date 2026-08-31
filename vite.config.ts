// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    define: {
      __BUILD_COMMIT__: JSON.stringify(buildCommit(true)),
      __BUILD_COMMIT_SHA__: JSON.stringify(buildCommit(false)),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __BUILD_MODE__: JSON.stringify(buildMode()),
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __HAS_OWNER_TEST_MODE__: JSON.stringify(hasOwnerTestMode),
    },
  },
});

