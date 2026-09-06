/**
 * WORKER WASM FINALISER
 *
 * The serverless runtime forbids compiling WebAssembly from bytes
 * ("Wasm code generation disallowed by embedder"), so the libopus binary used
 * by the RAIŌ WhatsApp voice note must be uploaded as a PRECOMPILED module.
 *
 * The Vite plugin in vite.config.ts keeps `./opus.wasm` as a relative external
 * import inside the server chunk. This step, run after the build output is
 * complete, places the binary next to every chunk that imports it and registers
 * the `CompiledWasm` upload rule so the runtime receives a WebAssembly.Module.
 *
 * It is a no-op when the build produced no such import.
 */
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const WASM_SOURCE = "src/lib/voice/opus/opus.wasm";
const SERVER_DIR = path.join(process.cwd(), "dist/server");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

const chunks = await walk(SERVER_DIR);
const targets = new Set();
for (const chunk of chunks) {
  const code = await readFile(chunk, "utf8").catch(() => "");
  if (code.includes('"./opus.wasm"') || code.includes("'./opus.wasm'")) {
    targets.add(path.dirname(chunk));
  }
}

if (targets.size === 0) {
  console.log("[worker-wasm] no ./opus.wasm import in server output — nothing to do");
} else {
  for (const dir of targets) {
    await copyFile(WASM_SOURCE, path.join(dir, "opus.wasm"));
    console.log(`[worker-wasm] placed opus.wasm in ${path.relative(process.cwd(), dir)}`);
  }
  const configPath = path.join(SERVER_DIR, "wrangler.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const rules = Array.isArray(config.rules) ? config.rules : [];
    if (!rules.some((rule) => rule.type === "CompiledWasm")) {
      rules.push({ type: "CompiledWasm", globs: ["**/*.wasm"] });
    }
    await writeFile(configPath, JSON.stringify({ ...config, rules }, null, 2));
    console.log("[worker-wasm] CompiledWasm rule registered");
  } catch {
    console.log("[worker-wasm] no wrangler config — skipped rule registration");
  }
}
