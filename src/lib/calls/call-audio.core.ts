/**
 * UMRAIO® — WhatsApp Calling audio container validation (pure, testable).
 *
 * The realtime voice-turn path can only emit OGG/Opus frames. Anything else
 * (MP3/audio\u002Fmpeg, truncated or non-Opus OGG) must be treated as a hard
 * failure so the caller never hears silent "success".
 */

/** "OggS" capture pattern of an OGG page. */
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53];
/** "OpusHead" identification header inside the first OGG page. */
const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];

function matchesAt(bytes: Uint8Array, pattern: number[], offset: number): boolean {
  if (bytes.byteLength < offset + pattern.length) return false;
  return pattern.every((byte, index) => bytes[offset + index] === byte);
}

export function isOggMimeType(mimeType: string): boolean {
  return (mimeType || "").split(";")[0]!.trim().toLowerCase() === "audio/ogg";
}

/** True only for a real OGG container whose first page carries an Opus stream. */
export function isOggOpusAudio(mimeType: string, bytes: Uint8Array): boolean {
  if (!isOggMimeType(mimeType)) return false;
  if (!matchesAt(bytes, OGG_MAGIC, 0)) return false;
  // OpusHead lives in the first page payload (header is 27 bytes + segment table).
  const limit = Math.min(bytes.byteLength, 128);
  for (let offset = 0; offset + OPUS_HEAD.length <= limit; offset += 1) {
    if (matchesAt(bytes, OPUS_HEAD, offset)) return true;
  }
  return false;
}
