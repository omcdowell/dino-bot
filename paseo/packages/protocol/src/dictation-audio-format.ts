/**
 * Dictation audio wire formats (`dictation_stream_start.format` / `dictation_stream_chunk.format`).
 *
 * - PCM (every daemon): raw 16-bit little-endian mono PCM, base64 in `chunk.audio`.
 * - Opus (daemons with `server_info.features.dictationOpus`): 16 kHz mono Opus packets, framed
 *   "len16": each packet is a 2-byte big-endian length followed by that many bytes of one Opus
 *   packet (one 20 ms frame on the phone). A chunk holds whole packets only, so chunks decode in
 *   seq order with one decoder and a resend after a drop needs no extra state. No Ogg container:
 *   there is nothing to seek and the seq/ack layer already orders and dedups.
 */
export const DICTATION_PCM_FORMAT = "audio/pcm;rate=16000;bits=16";
export const DICTATION_OPUS_FORMAT = "audio/opus;rate=16000;channels=1;framing=len16";

export const DICTATION_OPUS_MAX_PACKET_BYTES = 0xffff;

export type DictationAudioEncoding = "pcm16" | "opus-len16";

function mimeOf(format: string): string {
  return format.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function paramOf(format: string, name: string): string | null {
  for (const part of format.split(";").slice(1)) {
    const [key, value] = part.split("=", 2);
    if (key?.trim().toLowerCase() === name && value !== undefined) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

/**
 * The encoding a format string asks for, or null for an Opus variant this code does not read.
 * Anything that is not audio/opus stays PCM, which is what every daemon assumed before Opus.
 */
export function resolveDictationAudioEncoding(format: string): DictationAudioEncoding | null {
  if (mimeOf(format) !== "audio/opus") {
    return "pcm16";
  }
  const channels = paramOf(format, "channels");
  if (paramOf(format, "framing") !== "len16" || (channels !== null && channels !== "1")) {
    return null;
  }
  return "opus-len16";
}

export function isDictationOpusFormat(format: string): boolean {
  return resolveDictationAudioEncoding(format) === "opus-len16";
}

/** Frame Opus packets as len16 (2-byte big-endian length + bytes). */
export function joinLen16OpusPackets(packets: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const packet of packets) {
    if (packet.length === 0 || packet.length > DICTATION_OPUS_MAX_PACKET_BYTES) {
      throw new Error(`Invalid Opus packet size: ${packet.length}`);
    }
    total += 2 + packet.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const packet of packets) {
    out[offset] = (packet.length >> 8) & 0xff;
    out[offset + 1] = packet.length & 0xff;
    out.set(packet, offset + 2);
    offset += 2 + packet.length;
  }
  return out;
}

/** Split a len16 chunk into its Opus packets. Throws on a truncated or empty packet. */
export function splitLen16OpusPackets(bytes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) {
      throw new Error("Truncated Opus packet length");
    }
    const size = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    if (size === 0 || offset + size > bytes.length) {
      throw new Error(`Truncated Opus packet (size ${size})`);
    }
    packets.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return packets;
}
