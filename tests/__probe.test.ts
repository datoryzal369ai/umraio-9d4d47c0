import { it } from "vitest";
import { OPUS_WASM_BASE64 } from "@/lib/voice/opus/opus-wasm.base64";
it("probe", async () => {
  console.log("B64LEN", OPUS_WASM_BASE64?.length);
  const bin = atob(OPUS_WASM_BASE64);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  try {
    const { instance } = await WebAssembly.instantiate(b, {});
    console.log("INST OK", typeof (instance.exports as any).opus_encode);
  } catch (e) { console.log("INST THROW", String(e)); }
});
