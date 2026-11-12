import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { DaemonPermission } from "./authorization/index.js";

/**
 * Per-device session tokens: after one successful password check, a client gets a token it can
 * present instead of the password on later hellos. Checking the password (bcrypt, cost 12) takes
 * ~280 ms of daemon CPU on every connect; checking a token is one HMAC and a constant-time compare.
 *
 * - The token is random (32 secret bytes). The daemon keeps only an HMAC of it, keyed with a
 *   random key, so a memory dump or the state file yields no usable token (the secret is only on
 *   the device).
 * - It is bound to the clientId and the transport (direct/relay plus its E2EE mode) it was
 *   issued on: the same secret presented by another clientId or over another path is refused.
 * - It expires (24 h by default; a token used in its second half is replaced by a fresh one).
 * - Changing the password invalidates every token. Tokens can also be revoked one client at a
 *   time or all at once.
 * - With `persistPath` (the daemon: PASEO_HOME/session-tokens.json, mode 600) the key and the
 *   HMACs survive a restart or an update, so a paired phone reconnects with its token and is not
 *   sent back to the password (RU1: a restart used to drop every token, and a phone whose stored
 *   password had gone stale had to pair again). Without it (tests, the default) tokens live in
 *   memory only. An unreadable or foreign file is ignored and replaced: tokens are a fast path,
 *   the password still works.
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

/** On-disk form (PASEO_HOME/session-tokens.json). Secrets are never written, only their HMACs. */
interface PersistedTokenEntry {
  id: string;
  mac: string;
  clientId: string;
  principalId: string;
  permissions: string[];
  passwordFingerprint: string;
  issuedAt: number;
  expiresAt: number;
}

interface PersistedTokenFile {
  version: 1;
  key: string;
  entries: PersistedTokenEntry[];
}

export const SESSION_TOKEN_FILE_NAME = "session-tokens.json";

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
  private readonly persistPath: string | null;
  private readonly onPersistError: (error: unknown, action: "load" | "save") => void;

  constructor(options: {
    getPasswordHash: () => string | undefined;
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
    key?: Buffer;
    /** Keep the key and the token HMACs in this file (mode 600) across restarts. */
    persistPath?: string;
    onPersistError?: (error: unknown, action: "load" | "save") => void;
  }) {
    this.getPasswordHash = options.getPasswordHash;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_SESSION_TOKEN_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.persistPath = options.persistPath ?? null;
    this.onPersistError = options.onPersistError ?? (() => undefined);
    const loaded = this.persistPath ? this.load(this.persistPath) : null;
    this.key = loaded?.key ?? options.key ?? randomBytes(32);
    if (loaded) {
      const now = this.now();
      for (const entry of loaded.entries) {
        if (now >= entry.expiresAt) continue;
        this.entries.set(entry.id, {
          mac: Buffer.from(entry.mac, "base64"),
          clientId: entry.clientId,
          principalId: entry.principalId,
          permissions: entry.permissions as DaemonPermission[],
          passwordFingerprint: Buffer.from(entry.passwordFingerprint, "base64"),
          issuedAt: entry.issuedAt,
          expiresAt: entry.expiresAt,
        });
        this.idByClient.set(entry.clientId, entry.id);
      }
    } else if (this.persistPath) {
      // A fresh key: write it now, so the next start keeps it even before a token is issued.
      this.save();
    }
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
    this.save();
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
      this.save();
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
    this.save();
    return true;
  }

  revokeAll(): void {
    this.entries.clear();
    this.idByClient.clear();
    this.save();
  }

  private load(path: string): { key: Buffer; entries: PersistedTokenEntry[] } | null {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onPersistError(error, "load");
      return null;
    }
    try {
      const parsed = parsePersistedTokenFile(JSON.parse(raw));
      if (!parsed) throw new Error(`${path}: not a session token file`);
      return { key: Buffer.from(parsed.key, "base64"), entries: parsed.entries };
    } catch (error) {
      this.onPersistError(error, "load");
      return null;
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    const file: PersistedTokenFile = {
      version: 1,
      key: this.key.toString("base64"),
      entries: [...this.entries].map(([id, entry]) => ({
        id,
        mac: entry.mac.toString("base64"),
        clientId: entry.clientId,
        principalId: entry.principalId,
        permissions: [...entry.permissions],
        passwordFingerprint: entry.passwordFingerprint.toString("base64"),
        issuedAt: entry.issuedAt,
        expiresAt: entry.expiresAt,
      })),
    };
    const tmp = `${this.persistPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.persistPath);
    } catch (error) {
      rmSync(tmp, { force: true });
      this.onPersistError(error, "save");
    }
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

function parsePersistedTokenFile(value: unknown): PersistedTokenFile | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Partial<PersistedTokenFile>;
  if (file.version !== 1 || typeof file.key !== "string" || !Array.isArray(file.entries)) {
    return null;
  }
  if (Buffer.from(file.key, "base64").length !== 32) return null;
  const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const entries = file.entries.filter(
    (entry): entry is PersistedTokenEntry =>
      !!entry &&
      typeof entry === "object" &&
      isString(entry.id) &&
      isString(entry.mac) &&
      isString(entry.clientId) &&
      isString(entry.principalId) &&
      Array.isArray(entry.permissions) &&
      entry.permissions.every(isString) &&
      isString(entry.passwordFingerprint) &&
      Number.isFinite(entry.issuedAt) &&
      Number.isFinite(entry.expiresAt),
  );
  return { version: 1, key: file.key, entries };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
