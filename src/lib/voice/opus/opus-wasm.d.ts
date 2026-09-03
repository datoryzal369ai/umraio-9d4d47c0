/**
 * `.wasm` imports resolve differently per runtime:
 *   - Worker/Cloudflare bundle: an already-compiled `WebAssembly.Module`.
 *   - Node/vite dev/vitest: a URL or asset path string.
 * The loader in `opus-encode.server.ts` narrows both shapes safely.
 */
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module | string;
  export default wasmModule;
}
