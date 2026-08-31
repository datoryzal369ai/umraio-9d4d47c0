declare module "*.wasm" {
  export const memory: WebAssembly.Memory;
  export function malloc(size: number): number;
  export function free(ptr: number): void;
  export function opus_encoder_get_size(channels: number): number;
  export function opus_encoder_init(
    ptr: number,
    rate: number,
    channels: number,
    application: number,
  ): number;
  export function opus_encoder_ctl_set(ptr: number, request: number, value: number): number;
  export function opus_encoder_ctl_get(ptr: number, request: number): number;
  export function opus_encode(
    ptr: number,
    pcm: number,
    frameSize: number,
    out: number,
    maxBytes: number,
  ): number;
}

/** Cloudflare CompiledWasm import: the bundler emits the binary as a Worker module. */
declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}
