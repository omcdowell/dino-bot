/**
 * Avatar saves on the device (AV3): optimistic, queued while offline, sent later, with a revision.
 *
 * - Save is instant: `enqueueSave` gives the avatar the next revision for that bot, keeps it as the bot's
 *   `saved` copy (drawn at once in place of the server's PNG) and queues it.
 * - The queue lives in one persisted query (client/avatar-outbox-data.ts), so a save made offline survives an
 *   app restart and is sent when the host answers again.
 * - One pending save per bot: a newer save replaces a queued older one (only the newest picture matters, and its
 *   revision is higher anyway).
 * - Revisions count up per bot from the highest one the device knows (its own saves and what the host reported).
 *   The host refuses a revision <= its stored one, so a resend of an old save can never overwrite a newer save:
 *   when the host says "stale" the queued save is dropped and the device stops drawing its copy.
 * - A thrown error (offline, timeout) keeps the save queued and retries with backoff (2 s doubling, max 5 min);
 *   a save the host calls invalid is dropped with its error.
 *
 * Pure (no React): runs under `tsx --test`. Anything read back from the device is normalised; nothing throws.
 */
import { AvatarJsonSchema, type AvatarJson } from "../shared/avatar";
import type { AvatarApi, AvatarSaveResult } from "./avatar-api";

export interface PendingSave {
  avatar: AvatarJson;
  queuedAt: number;
  attempts: number;
  /** Not before this time (ms). */
  nextAt: number;
  lastError?: string;
}

export interface BotAvatarEntry {
  /** Highest revision the host has confirmed or reported for this bot. */
  known: number;
  /** The newest avatar.json made on this device (drawn optimistically, see `optimisticAvatar`). */
  saved?: AvatarJson;
  /** The bot list's avatarHash when `saved` was made: once the hash moves on, the host's PNG is current. */
  hashAtSave?: string | null;
  pending?: PendingSave;
  /** Why the last save did not land (stale / invalid), for the UI. Cleared by the next save. */
  dropped?: { revision: number; reason: "stale" | "invalid"; error?: string; at: number };
}

export interface AvatarOutbox {
  v: 1;
  bots: Record<string, BotAvatarEntry>;
}

export const EMPTY_OUTBOX: AvatarOutbox = { v: 1, bots: {} };
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 5 * 60_000;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown, d = 0) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const avatarOf = (x: unknown): AvatarJson | undefined => {
  const r = AvatarJsonSchema.safeParse(x);
  return r.success ? r.data : undefined;
};

/** Whatever the device kept, as an outbox (bad entries dropped, bad fields defaulted). */
export function normaliseOutbox(raw: unknown): AvatarOutbox {
  if (!isObject(raw) || raw.v !== 1 || !isObject(raw.bots)) return EMPTY_OUTBOX;
  const bots: Record<string, BotAvatarEntry> = {};
  for (const [id, e] of Object.entries(raw.bots)) {
    if (!isObject(e)) continue;
    const entry: BotAvatarEntry = { known: Math.max(0, Math.floor(num(e.known))) };
    const saved = avatarOf(e.saved);
    if (saved) entry.saved = saved;
    if (typeof e.hashAtSave === "string" || e.hashAtSave === null) entry.hashAtSave = e.hashAtSave as string | null;
    if (isObject(e.pending)) {
      const avatar = avatarOf(e.pending.avatar);
      if (avatar)
        entry.pending = {
          avatar,
          queuedAt: num(e.pending.queuedAt),
          attempts: Math.max(0, Math.floor(num(e.pending.attempts))),
          nextAt: num(e.pending.nextAt),
          ...(typeof e.pending.lastError === "string" ? { lastError: e.pending.lastError } : {}),
        };
    }
    if (isObject(e.dropped) && (e.dropped.reason === "stale" || e.dropped.reason === "invalid"))
      entry.dropped = {
        revision: num(e.dropped.revision),
        reason: e.dropped.reason,
        at: num(e.dropped.at),
        ...(typeof e.dropped.error === "string" ? { error: e.dropped.error } : {}),
      };
    bots[id] = entry;
  }
  return { v: 1, bots };
}

const entryOf = (box: AvatarOutbox, botId: string): BotAvatarEntry => box.bots[botId] ?? { known: 0 };
const withEntry = (box: AvatarOutbox, botId: string, entry: BotAvatarEntry): AvatarOutbox => ({
  v: 1,
  bots: { ...box.bots, [botId]: entry },
});

/** The highest revision the device knows for this bot (host-reported, saved here, or queued). */
export function highestRevision(box: AvatarOutbox, botId: string): number {
  const e = box.bots[botId];
  if (!e) return 0;
  return Math.max(e.known, e.saved?.revision ?? 0, e.pending?.avatar.revision ?? 0);
}

/** The revision a new save of this bot gets. */
export const nextRevision = (box: AvatarOutbox, botId: string): number => highestRevision(box, botId) + 1;

/**
 * Queue a save. `avatar.revision` is replaced by the next revision for the bot. Returns the new outbox and the
 * avatar as queued. `currentHash` is the bot list's avatarHash now (null / undefined when unknown).
 */
export function enqueueSave(
  box: AvatarOutbox,
  botId: string,
  avatar: AvatarJson,
  now: number,
  currentHash?: string | null,
): { box: AvatarOutbox; avatar: AvatarJson } {
  const queued: AvatarJson = { ...avatar, revision: nextRevision(box, botId) };
  const e = entryOf(box, botId);
  const entry: BotAvatarEntry = {
    known: e.known,
    saved: queued,
    hashAtSave: currentHash ?? null,
    pending: { avatar: queued, queuedAt: now, attempts: 0, nextAt: now },
  };
  return { box: withEntry(box, botId, entry), avatar: queued };
}

/** The host reported its stored revision (a get, or a list): never lowers what the device knows. */
export function noteHostRevision(box: AvatarOutbox, botId: string, revision: number): AvatarOutbox {
  const e = entryOf(box, botId);
  if (revision <= e.known) return box;
  return withEntry(box, botId, { ...e, known: revision });
}

/** Saves to send now: `{ botId, avatar }`, oldest first. */
export function dueSaves(box: AvatarOutbox, now: number): Array<{ botId: string; avatar: AvatarJson }> {
  return Object.entries(box.bots)
    .filter(([, e]) => e.pending && e.pending.nextAt <= now)
    .sort(([, a], [, b]) => a.pending!.queuedAt - b.pending!.queuedAt)
    .map(([botId, e]) => ({ botId, avatar: e.pending!.avatar }));
}

/** When the next queued save is due (ms), or null with nothing queued. */
export function nextDueAt(box: AvatarOutbox): number | null {
  let at: number | null = null;
  for (const e of Object.values(box.bots)) if (e.pending && (at === null || e.pending.nextAt < at)) at = e.pending.nextAt;
  return at;
}

export const retryDelay = (attempts: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

/** The host answered the save of `revision` (the queue may hold a newer one by now: only that one's fate is kept). */
export function applySaveResult(box: AvatarOutbox, botId: string, revision: number, result: AvatarSaveResult, now: number): AvatarOutbox {
  const e = entryOf(box, botId);
  const isPending = e.pending?.avatar.revision === revision;
  if (result.ok) {
    const entry: BotAvatarEntry = { ...e, known: Math.max(e.known, result.revision, revision) };
    if (isPending) delete entry.pending;
    delete entry.dropped;
    return withEntry(box, botId, entry);
  }
  if (result.reason === "stale") {
    // The host has a newer save (another device): this one, and any queued save not above it, never lands.
    const known = Math.max(e.known, result.currentRevision);
    const entry: BotAvatarEntry = { ...e, known, dropped: { revision, reason: "stale", at: now } };
    if (entry.pending && entry.pending.avatar.revision <= known) delete entry.pending;
    if (entry.saved && entry.saved.revision <= known) {
      delete entry.saved;
      delete entry.hashAtSave;
    }
    return withEntry(box, botId, entry);
  }
  // invalid: the host cannot draw it (e.g. an id its pack lacks). Resending would fail the same way.
  const entry: BotAvatarEntry = { ...e, dropped: { revision, reason: "invalid", error: result.error, at: now } };
  if (isPending) delete entry.pending;
  if (entry.saved?.revision === revision) {
    delete entry.saved;
    delete entry.hashAtSave;
  }
  return withEntry(box, botId, entry);
}

/** Sending failed (offline, timeout, host without the RPC yet): keep it queued and back off. */
export function applySaveFailure(box: AvatarOutbox, botId: string, revision: number, error: string, now: number): AvatarOutbox {
  const e = entryOf(box, botId);
  if (!e.pending || e.pending.avatar.revision !== revision) return box;
  const attempts = e.pending.attempts + 1;
  return withEntry(box, botId, { ...e, pending: { ...e.pending, attempts, nextAt: now + retryDelay(attempts), lastError: error } });
}

/** Retry everything now (the host just came back). */
export function retryNow(box: AvatarOutbox, now: number): AvatarOutbox {
  let changed = false;
  const bots: Record<string, BotAvatarEntry> = {};
  for (const [id, e] of Object.entries(box.bots)) {
    if (e.pending && e.pending.nextAt > now) {
      bots[id] = { ...e, pending: { ...e.pending, nextAt: now } };
      changed = true;
    } else bots[id] = e;
  }
  return changed ? { v: 1, bots } : box;
}

/**
 * The avatar.json the device should draw for this bot in place of the host's PNG, or null to use the PNG:
 * while a save is queued, and after it lands until the bot list's avatarHash moves on (the host has rendered it).
 */
export function optimisticAvatar(entry: BotAvatarEntry | undefined, currentHash: string | null | undefined): AvatarJson | null {
  if (!entry?.saved) return null;
  if (entry.pending) return entry.saved;
  return (currentHash ?? null) === (entry.hashAtSave ?? null) ? entry.saved : null;
}

/** "Saving…" / "Waiting for connection" / null: the bot's save state for the UI. */
export function saveStatus(entry: BotAvatarEntry | undefined): "sending" | "queued" | "stale" | "invalid" | null {
  if (entry?.pending) return entry.pending.attempts > 0 ? "queued" : "sending";
  return entry?.dropped?.reason ?? null;
}

/**
 * Send what is due, one save per bot, and fold the answers in. `read` / `write` reach the stored outbox (they are
 * called again after every answer, so saves queued meanwhile are kept). Returns how many saves landed.
 */
export async function drainOutbox(
  read: () => AvatarOutbox,
  write: (update: (box: AvatarOutbox) => AvatarOutbox) => void,
  api: Pick<AvatarApi, "save">,
  now: () => number,
  inFlight: Set<string> = new Set(),
): Promise<number> {
  let landed = 0;
  const due = dueSaves(read(), now()).filter((s) => !inFlight.has(s.botId));
  await Promise.all(
    due.map(async ({ botId, avatar }) => {
      inFlight.add(botId);
      try {
        const result = await api.save({ botId, avatar });
        if (result.ok) landed++;
        write((box) => applySaveResult(box, botId, avatar.revision, result, now()));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        write((box) => applySaveFailure(box, botId, avatar.revision, message, now()));
      } finally {
        inFlight.delete(botId);
      }
    }),
  );
  return landed;
}
