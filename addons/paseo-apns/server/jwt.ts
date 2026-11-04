/**
 * APNs provider token (ES256 JWT), minted from the .p8 key and reused.
 *
 * The key is read from its path only while a token is minted, and only the resulting KeyObject is
 * used, inside this function. Nothing here logs, returns or stores key material. A load or sign
 * failure surfaces as ApnsKeyError carrying the error code only (ENOENT, ERR_OSSL_*, ...), never
 * the underlying message, which could quote file content.
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

export class ApnsKeyError extends Error {
  constructor(readonly code: string) {
    super(`APNs key unusable (${code})`);
    this.name = "ApnsKeyError";
  }
}

/** Apple rejects tokens refreshed more often than this (TooManyProviderTokenUpdates). */
export const MIN_REFRESH_MS = 20 * 60_000;

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export interface ProviderTokenOptions {
  keyPath: string;
  keyId: string;
  teamId: string;
  reuseMs: number;
  now?: () => number;
  /** Test seam; production reads the file. */
  readKey?: (path: string) => Buffer;
}

export function mintJwt(key: Buffer, keyId: string, teamId: string, issuedAtSec: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: issuedAtSec }));
  const input = `${header}.${claims}`;
  let signature: Buffer;
  try {
    const keyObject = createPrivateKey(key);
    signature = sign("sha256", Buffer.from(input), { key: keyObject, dsaEncoding: "ieee-p1363" });
  } catch (error) {
    throw new ApnsKeyError(String((error as NodeJS.ErrnoException).code ?? "ERR_SIGN"));
  }
  return `${input}.${b64url(signature)}`;
}

export class ProviderToken {
  private token: string | null = null;
  private mintedAt = 0;
  private readonly now: () => number;
  private readonly readKey: (path: string) => Buffer;

  constructor(private readonly options: ProviderTokenOptions) {
    this.now = options.now ?? Date.now;
    this.readKey = options.readKey ?? ((path) => readFileSync(path));
  }

  /** Current token, minted afresh once it is older than reuseMs. */
  get(): string {
    if (this.token && this.now() - this.mintedAt < this.options.reuseMs) return this.token;
    return this.mint();
  }

  /** After 403 ExpiredProviderToken: mint again, unless the current one is under 20 min old. */
  refresh(): string | null {
    if (this.token && this.now() - this.mintedAt < MIN_REFRESH_MS) return null;
    return this.mint();
  }

  get ageMs(): number | null {
    return this.token ? this.now() - this.mintedAt : null;
  }

  private mint(): string {
    let key: Buffer;
    try {
      key = this.readKey(this.options.keyPath);
    } catch (error) {
      throw new ApnsKeyError(String((error as NodeJS.ErrnoException).code ?? "ERR_READ"));
    }
    const at = this.now();
    try {
      this.token = mintJwt(key, this.options.keyId, this.options.teamId, Math.floor(at / 1000));
    } finally {
      key.fill(0);
    }
    this.mintedAt = at;
    return this.token;
  }
}
