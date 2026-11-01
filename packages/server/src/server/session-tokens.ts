import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DaemonPermission } from "./authorization/index.js";

/**
 * Per-device session tokens: after one successful password check, a client gets a token it can
 * present instead of the password on later hellos. Checking the password (bcrypt, cost 12) takes
 * ~280 ms of daemon CPU on every connect; checking a token is one HMAC and a constant-time compare.
 *
 * - The token is random (32 secret bytes). The daemon keeps only an HMAC of it, keyed with a
 *   per-process random key, so neither a daemon restart nor a memory dump yields usable tokens.
 * - It is bound to the clientId and the transport (direct/relay plus its E2EE mode) it was
 *   issued on: the same secret presented by another clientId or over another path is refused.
 * - It expires (24 h by default; a token used in its second half is replaced by a fresh one).
 * - Restarting the daemon or changing the password invalidates every token. Tokens can also be
 *   revoked one client at a time or all at once.
 */

export const SESSION_TOKEN_PREFIX = "pst1";
export const DEFAULT_SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_TOKEN_MAX_ENTRIES = 512;

export interface SessionTokenBinding {
  clientId: string;
  /** e.g. "direct:protected", "relay:protected", "direct:none" */
  channel: string;
}

export interface SessionTokenGrant {
  principalId: string;
  permissions: readonly DaemonPermission[];
}

export interface IssuedSessionToken {
  token: string;
  expiresAt: number;
}

interface TokenEntry {
  mac: Buffer;
  clientId: string;
  principalId: string;
  permissions: readonly DaemonPermission[];
  passwordFingerprint: Buffer;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionTokenVerification extends SessionTokenGrant {
  /** The token is in the second half of its life: issue a replacement. */
  renew: boolean;
}

export class SessionTokenStore {
  private readonly key: Buffer;
  private readonly entries = new Map<string, TokenEntry>();
  private readonly idByClient = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly getPasswordHash: () => string | undefined;

  constructor(options: {
    getPasswordHash: () => string | undefined;
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
    key?: Buffer;
  }) {
    this.getPasswordHash = options.getPasswordHash;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_SESSION_TOKEN_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.key = options.key ?? randomBytes(32);
  }

  get size(): number {
    return this.entries.size;
  }

  issue(grant: SessionTokenGrant, binding: SessionTokenBinding): IssuedSessionToken | null {
    const passwordHash = this.getPasswordHash();
    if (!passwordHash) return null;
    this.revokeClient(binding.clientId);
    this.evictExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.deleteEntry(oldest);
    }
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlMs;
    this.entries.set(id, {
      mac: this.mac(id, secret, binding),
      clientId: binding.clientId,
      principalId: grant.principalId,
      permissions: grant.permissions,
      passwordFingerprint: this.fingerprint(passwordHash),
      issuedAt,
      expiresAt,
    });
    this.idByClient.set(binding.clientId, id);
    return { token: `${SESSION_TOKEN_PREFIX}.${id}.${secret}`, expiresAt };
  }

  verify(token: string, binding: SessionTokenBinding): SessionTokenVerification | null {
    const passwordHash = this.getPasswordHash();
    if (!passwordHash) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_PREFIX) return null;
    const [, id, secret] = parts as [string, string, string];
    if (id.length === 0 || secret.length === 0 || secret.length > 128) return null;
    const entry = this.entries.get(id);
    if (!entry) return null;
    const now = this.now();
    if (now >= entry.expiresAt) {
      this.deleteEntry(id);
      return null;
    }
    const macOk = safeEqual(this.mac(id, secret, binding), entry.mac);
    const passwordOk = safeEqual(this.fingerprint(passwordHash), entry.passwordFingerprint);
    if (!macOk || !passwordOk) return null;
    return {
      principalId: entry.principalId,
      permissions: entry.permissions,
      renew: now - entry.issuedAt >= this.ttlMs / 2,
    };
  }

  revokeClient(clientId: string): boolean {
    const id = this.idByClient.get(clientId);
    if (id === undefined) return false;
    this.deleteEntry(id);
    return true;
  }

  revokeAll(): void {
    this.entries.clear();
    this.idByClient.clear();
  }

  private deleteEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (this.idByClient.get(entry.clientId) === id) this.idByClient.delete(entry.clientId);
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now >= entry.expiresAt) this.deleteEntry(id);
    }
  }

  private mac(id: string, secret: string, binding: SessionTokenBinding): Buffer {
    return createHmac("sha256", this.key)
      .update(
        JSON.stringify(["session-token", id, secret, binding.clientId, binding.channel]),
        "utf8",
      )
      .digest();
  }

  private fingerprint(passwordHash: string): Buffer {
    return createHmac("sha256", this.key).update("password\0").update(passwordHash).digest();
  }
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
