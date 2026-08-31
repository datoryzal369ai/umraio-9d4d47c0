import { it } from "vitest";
it("probe", async () => {
  try {
    const m = await import("@/lib/voice/opus/opus.wasm?module");
    console.log("IMPORT OK", typeof m, Object.keys(m as object), typeof (m as any).default);
  } catch (e) { console.log("IMPORT THROW", String(e)); }
  const { encodePcmToOggOpus } = await import("@/lib/voice/opus-encode.server");
  console.log("RESULT", JSON.stringify(await encodePcmToOggOpus(new Uint8Array(24000))));
});
