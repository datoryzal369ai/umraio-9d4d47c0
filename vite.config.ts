// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

/**
 * Cloudflare CompiledWasm support for `import("./x.wasm?module")`.
 *
 * workerd forbids runtime WebAssembly compilation, so the libopus binary has to
 * reach the Worker as a real module import that the platform compiles at deploy
 * time. Rolldown has no `.wasm` loader, so we keep the specifier EXTERNAL — the
 * emitted chunk keeps a literal `import("./opus.wasm")`, and wrangler's default
 * `**\/*.wasm -> CompiledWasm` module rule turns it into a compiled module.
 * The binary is copied into every server output directory after the build.
 * Server-only by construction: the sole importer is `*.server.ts`.
 */
const OPUS_WASM = resolve("src/lib/voice/opus/opus.wasm");

function compiledWasm(): Plugin {
  return {
    name: "umraio-compiled-wasm",
    enforce: "pre",
    resolveId(id) {
      if (!id.endsWith(".wasm?module")) return null;
      // Keep `?module` so nitro's wasm plugin emits a CompiledWasm ESM import
      // (never a runtime `WebAssembly.compile` of inline bytes).
      return { id: "./opus.wasm?module", external: true };
    },
    writeBundle(options) {
      const dir = options.dir ?? (options.file ? dirname(options.file) : undefined);
      // Server graph only — the binary must never land in the client bundle.
      if (!dir || dir.includes("client") || !existsSync(OPUS_WASM)) return;
      const walk = (target: string) => {
        for (const entry of readdirSync(target)) {
          const full = join(target, entry);
          if (statSync(full).isDirectory()) walk(full);
        }
        copyFileSync(OPUS_WASM, join(target, "opus.wasm"));
      };
      mkdirSync(dir, { recursive: true });
      walk(dir);
    },
  };
}

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

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [compiledWasm()],
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

