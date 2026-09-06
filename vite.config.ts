// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";

/** Build-time commit hash of the bundle that is actually being served. */
function buildCommit(short: boolean): string {
  try {
    return execSync(`git rev-parse ${short ? "--short " : ""}HEAD`, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Whether the Owner Test Mode console is compiled into this build. */
const hasOwnerTestMode = existsSync("src/components/settings/OwnerTestModePanel.tsx");

/** Vite mode of this build (`vite build --mode development` for preview builds). */
function buildMode(): string {
  const argv = process.argv;
  const idx = argv.indexOf("--mode");
  if (idx !== -1 && argv[idx + 1]) return String(argv[idx + 1]);
  if (argv.some((a) => a === "dev" || a === "serve")) return "development";
  return process.env["NODE_ENV"] === "development" ? "development" : "production";
}

const pkgVersion = (() => {
  try {
    return (JSON.parse(readFileSync("package.json", "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
})();

/**
 * WORKER WASM MODULE — the serverless runtime forbids compiling WebAssembly
 * from bytes at runtime ("Wasm code generation disallowed by embedder"), so the
 * libopus binary used by the RAIŌ voice note MUST be uploaded as a precompiled
 * module. This plugin keeps `./opus/opus.wasm?cfmodule` as a RELATIVE, EXTERNAL
 * import in the server chunk (no inlining, no runtime compile);
 * scripts/finalize-worker-wasm.mjs then places the binary next to the chunk and
 * registers the `CompiledWasm` upload rule.
 * Nothing here touches the client build, Text, Calling or MCP/Astra.
 */
function workerWasmModule() {
  return {
    name: "umraio-worker-wasm-module",
    apply: "build" as const,
    enforce: "pre" as const,
    resolveId(source: string) {
      if (source.endsWith("opus.wasm?cfmodule")) {
        return { id: "./opus.wasm", external: "relative" as const };
      }
      return null;
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [mcpPlugin(), workerWasmModule()],
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

