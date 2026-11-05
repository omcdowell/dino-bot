import { sha256Js } from "./sha256";

/** Web and Electron: WebCrypto where the origin allows it (not plain http), else plain JS. */
export async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return sha256Js(bytes);
  try {
    return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
  } catch {
    return sha256Js(bytes);
  }
}
