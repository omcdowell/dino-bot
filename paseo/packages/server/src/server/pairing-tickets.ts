import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * One-use pairing tickets (QR2). The pairing QR carries a ticket instead of the daemon password:
 *
 * - Minted by the installer (`dinobot setup` / `dinobot pair`, same user, no daemon round trip):
 *   `ppt1.<expiry ms, base36>.<nonce>.<HMAC>`, keyed with PASEO_HOME/pairing-ticket-key (mode 600,
 *   created by the first mint). A fresh ticket for every QR.
 * - Expires 10 minutes after minting (the life of the QR picture, lib/qr.mjs QR_PNG_TTL_MS). The
 *   daemon also refuses an expiry further out than PAIRING_TICKET_MAX_TTL_MS.
 * - One device: the first hello that presents it binds it to that clientId. The same clientId may
 *   present it again until it expires (the app probes the MagicDNS name and the tailnet IP side by
 *   side, and retries after a dropped socket); any other clientId is refused. Used tickets are kept
 *   in PASEO_HOME/pairing-tickets-used.json (mode 600, nonce -> clientId, until expiry), so a
 *   restart does not make a used ticket usable again.
 * - A ticket admits the device as the owner and gets it a long-lived device token
 *   (session-tokens.ts): that, not the ticket and not the password, keeps the device paired.
 * - Rotating the key (`rotatePairingTicketKey`, `dinobot devices --revoke-all`) voids every ticket
 *   not yet used. Changing the daemon password does not touch tickets (they never held it).
 */

export const PAIRING_TICKET_PREFIX = "ppt1";
export const PAIRING_TICKET_KEY_FILE = "pairing-ticket-key";
export const PAIRING_TICKET_USED_FILE = "pairing-tickets-used.json";
export const PAIRING_TICKET_TTL_MS = 10 * 60 * 1000;
export const PAIRING_TICKET_MAX_TTL_MS = 60 * 60 * 1000;

export interface MintedPairingTicket {
  ticket: string;
  expiresAt: number;
}

function keyPath(paseoHome: string): string {
  return join(paseoHome, PAIRING_TICKET_KEY_FILE);
}

function parseKey(text: string): Buffer | null {
  const key = Buffer.from(text.trim(), "base64");
  return key.length === 32 ? key : null;
}

function writeKeyAtomic(path: string, key: Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${key.toString("base64")}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** The ticket key, created (mode 600, exclusive) if missing or unreadable. */
function loadOrCreateKey(paseoHome: string): Buffer {
  const path = keyPath(paseoHome);
  try {
    const key = parseKey(readFileSync(path, "utf8"));
    if (key) return key;
  } catch {
    // Missing: create below.
  }
  const key = randomBytes(32);
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${key.toString("base64")}\n`);
    } finally {
      closeSync(fd);
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Another mint created it first, or the file is corrupt: read it again, else replace it.
  const again = parseKey(readFileSync(path, "utf8"));
  if (again) return again;
  writeKeyAtomic(path, key);
  return key;
}

function ticketMac(key: Buffer, expiry: string, nonce: string): Buffer {
  return createHmac("sha256", key).update(`pairing-ticket\0${expiry}\0${nonce}`, "utf8").digest();
}

/** A fresh one-use pairing ticket for the pairing QR (installer side; the daemon need not run). */
export function mintPairingTicket(
  paseoHome: string,
  options: { ttlMs?: number; now?: number } = {},
): MintedPairingTicket {
  const ttlMs = Math.min(options.ttlMs ?? PAIRING_TICKET_TTL_MS, PAIRING_TICKET_MAX_TTL_MS);
  const expiresAt = (options.now ?? Date.now()) + ttlMs;
  const key = loadOrCreateKey(paseoHome);
  const expiry = expiresAt.toString(36);
  const nonce = randomBytes(16).toString("base64url");
  const mac = ticketMac(key, expiry, nonce).toString("base64url");
  return { ticket: `${PAIRING_TICKET_PREFIX}.${expiry}.${nonce}.${mac}`, expiresAt };
}

/** Voids every ticket not yet used (new key). */
export function rotatePairingTicketKey(paseoHome: string): void {
  writeKeyAtomic(keyPath(paseoHome), randomBytes(32));
}

export type PairingTicketCheck =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "used" };

interface UsedEntry {
  clientId: string;
  expiresAt: number;
}

/** Daemon side: checks tickets and remembers which device used each one. */
export class PairingTicketVerifier {
  private readonly paseoHome: string;
  private readonly now: () => number;
  private readonly onPersistError: (error: unknown) => void;
  private keyCache: { stamp: string; key: Buffer | null } | null = null;
  private readonly used = new Map<string, UsedEntry>();

  constructor(options: {
    paseoHome: string;
    now?: () => number;
    onPersistError?: (error: unknown) => void;
  }) {
    this.paseoHome = options.paseoHome;
    this.now = options.now ?? Date.now;
    this.onPersistError = options.onPersistError ?? (() => undefined);
    this.loadUsed();
  }

  check(ticket: string, clientId: string): PairingTicketCheck {
    const parts = ticket.split(".");
    if (parts.length !== 4 || parts[0] !== PAIRING_TICKET_PREFIX) {
      return { ok: false, reason: "invalid" };
    }
    const [, expiry, nonce, mac] = parts as [string, string, string, string];
    if (!/^[0-9a-z]{1,12}$/.test(expiry) || !nonce || nonce.length > 64 || !mac) {
      return { ok: false, reason: "invalid" };
    }
    const key = this.key();
    if (!key) return { ok: false, reason: "invalid" };
    const given = Buffer.from(mac, "base64url");
    const expected = ticketMac(key, expiry, nonce);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: "invalid" };
    }
    const expiresAt = Number.parseInt(expiry, 36);
    const now = this.now();
    if (!Number.isFinite(expiresAt) || now >= expiresAt) return { ok: false, reason: "expired" };
    if (expiresAt - now > PAIRING_TICKET_MAX_TTL_MS) return { ok: false, reason: "invalid" };
    const seen = this.used.get(nonce);
    if (seen) return seen.clientId === clientId ? { ok: true } : { ok: false, reason: "used" };
    this.prune(now);
    this.used.set(nonce, { clientId, expiresAt });
    this.saveUsed();
    return { ok: true };
  }

  /** The key file as it is now (re-read when it changes: a rotation voids unused tickets). */
  private key(): Buffer | null {
    const path = keyPath(this.paseoHome);
    let stamp: string;
    try {
      const st = statSync(path);
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      this.keyCache = null;
      return null;
    }
    if (this.keyCache?.stamp !== stamp) {
      let key: Buffer | null = null;
      try {
        key = parseKey(readFileSync(path, "utf8"));
      } catch {
        key = null;
      }
      this.keyCache = { stamp, key };
    }
    return this.keyCache.key;
  }

  private prune(now: number): void {
    for (const [nonce, entry] of this.used) {
      if (now >= entry.expiresAt) this.used.delete(nonce);
    }
  }

  private loadUsed(): void {
    try {
      const parsed = JSON.parse(
        readFileSync(join(this.paseoHome, PAIRING_TICKET_USED_FILE), "utf8"),
      ) as { version?: unknown; used?: unknown };
      if (parsed?.version !== 1 || !parsed.used || typeof parsed.used !== "object") return;
      const now = this.now();
      for (const [nonce, value] of Object.entries(parsed.used as Record<string, unknown>)) {
        const entry = value as Partial<UsedEntry> | null;
        if (
          !entry ||
          typeof entry.clientId !== "string" ||
          typeof entry.expiresAt !== "number" ||
          now >= entry.expiresAt
        ) {
          continue;
        }
        this.used.set(nonce, { clientId: entry.clientId, expiresAt: entry.expiresAt });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onPersistError(error);
    }
  }

  private saveUsed(): void {
    const path = join(this.paseoHome, PAIRING_TICKET_USED_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(
        tmp,
        `${JSON.stringify({ version: 1, used: Object.fromEntries(this.used) })}\n`,
        {
          mode: 0o600,
        },
      );
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      this.onPersistError(error);
    }
  }
}
