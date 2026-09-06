/**
 * `.wasm?cfmodule` imports are kept as relative EXTERNAL imports in the
 * serverless bundle and uploaded as precompiled `CompiledWasm` modules, so the
 * runtime never has to compile WebAssembly from bytes. Runtimes without that
 * handling (node, vitest, dev) reject the dynamic import, which callers handle
 * by falling back.
 */
declare module "*.wasm?cfmodule" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
