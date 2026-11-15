import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 *
 * Device tokens (QR2): a client that advertises device_tokens gets a long-lived token instead.
 * It is what keeps a phone paired once the pairing QR no longer carries the password (the QR's
 * ticket is one-use, pairing-tickets.ts), so it must not end on a short clock:
 * - sliding idle expiry: 180 days after it was issued, and a device token used a day or more after
 *   its issue is replaced by a fresh one (so it ends only after ~180 days unused);
 * - renewal grace: a replaced token (device or not) stays valid for 7 days, until the device
 *   presents the newer one. A renewal lost with a dropped socket no longer signs the device out
 *   (before, the stored password hid this; a migrated phone has no password any more);
 * - revocation from outside the daemon (`dinobot devices --revoke`): PASEO_HOME/revoked-devices.json,
 *   written only by the CLI, read by the daemon when it changes. A token issued before the
 *   revocation time of its clientId (or of "*") is refused at its next use.
 */

export const SESSION_TOKEN_PREFIX = "pst1";
export const DEFAULT_SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_TOKEN_MAX_ENTRIES = 512;
export const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** A device token used this long after its issue is replaced (sliding expiry, one write a day). */
export const DEVICE_TOKEN_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long a replaced token stays valid while its device has not presented the newer one. */
export const TOKEN_RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tokens kept per clientId: the current one plus replaced ones still in their grace. */
const MAX_TOKENS_PER_CLIENT = 3;
export const REVOKED_DEVICES_FILE_NAME = "revoked-devices.json";

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
  /** Present (true) only on a device token. */
  device?: true;
}

export interface IssueOptions {
  /** A long-lived device token (client capability device_tokens). */
  device?: boolean;
  /** Shown by `dinobot devices`; not part of the token's binding. */
  label?: string;
}

interface TokenEntry {
  mac: Buffer;
  clientId: string;
  principalId: string;
  permissions: readonly DaemonPermission[];
  passwordFingerprint: Buffer;
  issuedAt: number;
  expiresAt: number;
  device?: boolean;
  /** When a newer token for the same clientId was issued (the renewal grace starts). */
  supersededAt?: number;
  label?: string;
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
  device?: boolean;
  supersededAt?: number;
  label?: string;
}

interface PersistedTokenFile {
  version: 1;
  key: string;
  entries: PersistedTokenEntry[];
}

export const SESSION_TOKEN_FILE_NAME = "session-tokens.json";

export interface SessionTokenVerification extends SessionTokenGrant {
  /** Issue a replacement: second half of its life, a device token a day old, or a replaced one. */
  renew: boolean;
  /** The presented token is a device token (its replacement is one too). */
  device?: boolean;
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
  private readonly revocationsPath: string | null;
  private revocations: RevocationCache = { stamp: null, revoked: {} };
  private readonly onPersistError: (error: unknown, action: "load" | "save") => void;

  constructor(options: {
    getPasswordHash: () => string | undefined;
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
    key?: Buffer;
    /** Keep the key and the token HMACs in this file (mode 600) across restarts. */
    persistPath?: string;
    /** revoked-devices.json (written by `dinobot devices --revoke`); default: next to persistPath. */
    revocationsPath?: string | null;
    onPersistError?: (error: unknown, action: "load" | "save") => void;
  }) {
    this.getPasswordHash = options.getPasswordHash;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_SESSION_TOKEN_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.persistPath = options.persistPath ?? null;
    this.revocationsPath = defaultRevocationsPath(options.revocationsPath, this.persistPath);
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
          ...(entry.device ? { device: true } : {}),
          ...(entry.supersededAt !== undefined ? { supersededAt: entry.supersededAt } : {}),
          ...(entry.label ? { label: entry.label } : {}),
        });
        if (entry.supersededAt === undefined) this.idByClient.set(entry.clientId, entry.id);
      }
    } else if (this.persistPath) {
      // A fresh key: write it now, so the next start keeps it even before a token is issued.
      this.save();
    }
  }

  get size(): number {
    return this.entries.size;
  }

  issue(
    grant: SessionTokenGrant,
    binding: SessionTokenBinding,
    options: IssueOptions = {},
  ): IssuedSessionToken | null {
    const passwordHash = this.getPasswordHash();
    if (!passwordHash) return null;
    const issuedAt = this.now();
    this.evictExpired();
    // The device's current token enters its renewal grace instead of ending now.
    const currentId = this.idByClient.get(binding.clientId);
    const current = currentId === undefined ? undefined : this.entries.get(currentId);
    if (current && current.supersededAt === undefined) current.supersededAt = issuedAt;
    this.trimClient(binding.clientId, MAX_TOKENS_PER_CLIENT - 1);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.deleteEntry(oldest);
    }
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const device = options.device === true;
    const expiresAt = issuedAt + (device ? DEVICE_TOKEN_TTL_MS : this.ttlMs);
    this.entries.set(id, {
      mac: this.mac(id, secret, binding),
      clientId: binding.clientId,
      principalId: grant.principalId,
      permissions: grant.permissions,
      passwordFingerprint: this.fingerprint(passwordHash),
      issuedAt,
      expiresAt,
      ...(device ? { device: true } : {}),
      ...(options.label ? { label: options.label.slice(0, 80) } : {}),
    });
    this.idByClient.set(binding.clientId, id);
    this.save();
    return {
      token: `${SESSION_TOKEN_PREFIX}.${id}.${secret}`,
      expiresAt,
      ...(device ? { device: true as const } : {}),
    };
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
    if (this.isExpired(entry, now) || this.isRevoked(entry)) {
      this.deleteEntry(id);
      this.save();
      return null;
    }
    const macOk = safeEqual(this.mac(id, secret, binding), entry.mac);
    const passwordOk = safeEqual(this.fingerprint(passwordHash), entry.passwordFingerprint);
    if (!macOk || !passwordOk) return null;
    // The device holds this token: the replaced ones before it are no longer needed.
    if (this.retireOlder(entry)) this.save();
    const age = now - entry.issuedAt;
    const renew =
      entry.supersededAt !== undefined ||
      (entry.device ? age >= DEVICE_TOKEN_RENEW_AFTER_MS : age >= this.ttlMs / 2);
    return {
      principalId: entry.principalId,
      permissions: entry.permissions,
      renew,
      ...(entry.device ? { device: true } : {}),
    };
  }

  revokeClient(clientId: string): boolean {
    let removed = false;
    for (const [id, entry] of this.entries) {
      if (entry.clientId !== clientId) continue;
      this.deleteEntry(id);
      removed = true;
    }
    if (removed) this.save();
    return removed;
  }

  revokeAll(): void {
    this.entries.clear();
    this.idByClient.clear();
    this.save();
  }

  private isExpired(entry: TokenEntry, now: number): boolean {
    if (now >= entry.expiresAt) return true;
    return entry.supersededAt !== undefined && now >= entry.supersededAt + TOKEN_RENEWAL_GRACE_MS;
  }

  /** Revoked from outside (revoked-devices.json): issued at or before its clientId's (or "*") time. */
  private isRevoked(entry: TokenEntry): boolean {
    const revoked = this.readRevocations();
    const at = Math.max(revoked[entry.clientId] ?? -Infinity, revoked["*"] ?? -Infinity);
    return entry.issuedAt <= at;
  }

  private readRevocations(): Record<string, number> {
    if (!this.revocationsPath) return {};
    let stamp: string | null = null;
    try {
      const st = statSync(this.revocationsPath);
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = null;
    }
    if (stamp === this.revocations.stamp) return this.revocations.revoked;
    this.revocations = { stamp, revoked: stamp ? readRevokedDevices(this.revocationsPath) : {} };
    return this.revocations.revoked;
  }

  /** Drops the client's replaced tokens issued before `entry`; true if any went. */
  private retireOlder(entry: TokenEntry): boolean {
    let removed = false;
    for (const [id, other] of this.entries) {
      if (other === entry || other.clientId !== entry.clientId) continue;
      if (other.supersededAt === undefined || other.issuedAt > entry.issuedAt) continue;
      this.deleteEntry(id);
      removed = true;
    }
    return removed;
  }

  /** Keeps at most `keep` tokens of a client (newest first). */
  private trimClient(clientId: string, keep: number): void {
    const ids = [...this.entries]
      .filter(([, entry]) => entry.clientId === clientId)
      .sort((a, b) => b[1].issuedAt - a[1].issuedAt)
      .map(([id]) => id);
    for (const id of ids.slice(Math.max(0, keep))) this.deleteEntry(id);
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
      entries: [...this.entries].map(([id, entry]) => toPersistedEntry(id, entry)),
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
      if (this.isExpired(entry, now)) this.deleteEntry(id);
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
      Number.isFinite(entry.expiresAt) &&
      (entry.supersededAt === undefined || Number.isFinite(entry.supersededAt)) &&
      (entry.device === undefined || typeof entry.device === "boolean") &&
      (entry.label === undefined || typeof entry.label === "string"),
  );
  return { version: 1, key: file.key, entries };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultRevocationsPath(
  given: string | null | undefined,
  persistPath: string | null,
): string | null {
  if (given !== undefined) return given;
  return persistPath ? join(persistPath, "..", REVOKED_DEVICES_FILE_NAME) : null;
}

function toPersistedEntry(id: string, entry: TokenEntry): PersistedTokenEntry {
  const out: PersistedTokenEntry = {
    id,
    mac: entry.mac.toString("base64"),
    clientId: entry.clientId,
    principalId: entry.principalId,
    permissions: [...entry.permissions],
    passwordFingerprint: entry.passwordFingerprint.toString("base64"),
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt,
  };
  if (entry.device) out.device = true;
  if (entry.supersededAt !== undefined) out.supersededAt = entry.supersededAt;
  if (entry.label) out.label = entry.label;
  return out;
}

interface RevocationCache {
  stamp: string | null;
  revoked: Record<string, number>;
}

/** revoked-devices.json: `{version: 1, revoked: {[clientId | "*"]: epoch ms}}`. Unreadable: {}. */
export function readRevokedDevices(path: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      revoked?: unknown;
    };
    if (parsed?.version !== 1 || !parsed.revoked || typeof parsed.revoked !== "object") return {};
    const out: Record<string, number> = {};
    for (const [clientId, at] of Object.entries(parsed.revoked as Record<string, unknown>)) {
      if (clientId && typeof at === "number" && Number.isFinite(at)) out[clientId] = at;
    }
    return out;
  } catch {
    return {};
  }
}

export interface PairedDevice {
  clientId: string;
  label: string | null;
  device: boolean;
  /** Issue time of its current token: a device token is reissued at most a day after each use. */
  issuedAt: number;
  expiresAt: number;
}

/**
 * The devices with a usable token in PASEO_HOME (for `dinobot devices`; the daemon may run).
 * One row per clientId (its newest token); expired and revoked ones are left out.
 */
export function listPairedDevices(paseoHome: string, now = Date.now()): PairedDevice[] {
  let file: PersistedTokenFile | null = null;
  try {
    file = parsePersistedTokenFile(
      JSON.parse(readFileSync(join(paseoHome, SESSION_TOKEN_FILE_NAME), "utf8")),
    );
  } catch {
    file = null;
  }
  if (!file) return [];
  const revoked = readRevokedDevices(join(paseoHome, REVOKED_DEVICES_FILE_NAME));
  const byClient = new Map<string, PersistedTokenEntry>();
  for (const entry of file.entries) {
    if (now >= entry.expiresAt) continue;
    if (entry.supersededAt !== undefined && now >= entry.supersededAt + TOKEN_RENEWAL_GRACE_MS) {
      continue;
    }
    const at = Math.max(revoked[entry.clientId] ?? -Infinity, revoked["*"] ?? -Infinity);
    if (entry.issuedAt <= at) continue;
    const seen = byClient.get(entry.clientId);
    if (!seen || entry.issuedAt > seen.issuedAt) byClient.set(entry.clientId, entry);
  }
  return [...byClient.values()]
    .sort((a, b) => b.issuedAt - a.issuedAt)
    .map((entry) => ({
      clientId: entry.clientId,
      label: entry.label ?? null,
      device: entry.device === true,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
    }));
}

/**
 * Revokes devices' tokens from outside the daemon: the given clientIds, or every device ("all").
 * The daemon refuses a revoked token at its next use (an open connection stays until it drops).
 */
export function revokePairedDevices(
  paseoHome: string,
  target: string[] | "all",
  now = Date.now(),
): void {
  const path = join(paseoHome, REVOKED_DEVICES_FILE_NAME);
  const revoked = readRevokedDevices(path);
  for (const clientId of target === "all" ? ["*"] : target) revoked[clientId] = now;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, revoked })}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
