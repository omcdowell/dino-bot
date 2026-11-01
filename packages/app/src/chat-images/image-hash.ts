/**
 * The daemon names a chat image by the sha256 of its bytes (server chat-images/store.ts). The
 * sending device hashes the same bytes before they go up, so it knows the image's id before the
 * daemon's reference arrives and can show its own copy for it.
 */
import { sha256Digest } from "./image-hash-digest";

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

/** Decodes base64 (or a data: URL) the way the daemon does: Buffer.from(data, "base64"). */
export function decodeImageBase64(data: string): Uint8Array {
  const dataUrl = /^data:[^,]*;base64,/.exec(data);
  const body = dataUrl ? data.slice(dataUrl[0].length) : data;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4) + 3);
  let length = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i += 1) {
    const value = BASE64_LOOKUP[body.charCodeAt(i)] ?? -1;
    if (value < 0) {
      if (body[i] === "=") break;
      continue;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length] = (buffer >> bits) & 0xff;
      length += 1;
    }
  }
  return out.subarray(0, length);
}

/** The daemon's id for an image sent as this base64 payload. */
export async function chatImageIdForBase64(data: string): Promise<string> {
  return toHex(await sha256Digest(decodeImageBase64(data)));
}
