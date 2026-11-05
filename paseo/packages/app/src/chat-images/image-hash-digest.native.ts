import * as ExpoCrypto from "expo-crypto";
import { sha256Js } from "./sha256";

/** Phone: the native digest (a multi-megabyte photo in plain JS would hold the JS thread). */
export async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, bytes as BufferSource),
    );
  } catch {
    return sha256Js(bytes);
  }
}
