/**
 * Room ledger (§3.2): `<rooms root>/<group>/room.jsonl`, append only, one JSON line per message.
 * Dir 0700, files 0600. Writers hold flock on `<dir>/.lock` (same helper as the DM ledger), and each
 * line goes out in one write() on an O_APPEND descriptor. Readers read the last 256 KB.
 */
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withLocks } from "../ledger-write";
import { readTailLines, TAIL_BYTES } from "../ledger";
import { RoomMessageSchema, type RoomMessage } from "../../shared/rooms/schema";
import { normalizeParties } from "../../shared/party";

export const ROOM_FILE = "room.jsonl";
export const SESSIONS_FILE = "sessions.json";
export const ROUTER_FILE = "router.json";

/** `$PASEO_BOTS_ROOMS`, else `~/.local/state/bot-rooms`. */
export function roomsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_BOTS_ROOMS || join(homedir(), ".local", "state", "bot-rooms");
}

export function roomDir(root: string, group: string): string {
  return join(root, group);
}

export function ensureRoomDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function isRoomMessage(value: unknown): value is RoomMessage {
  return RoomMessageSchema.safeParse(value).success;
}

/** Appends one line. Call only while holding the dir lock. */
export function appendLine(dir: string, msg: RoomMessage): void {
  const path = join(dir, ROOM_FILE);
  const line = Buffer.from(`${JSON.stringify(msg)}\n`, "utf8");
  const fd = openSync(path, "a+", 0o600);
  try {
    // A torn last line (crashed writer): start ours on a fresh line so it still parses.
    const size = fstatSync(fd).size;
    let buf = line;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) buf = Buffer.concat([Buffer.from("\n"), line]);
    }
    const written = writeSync(fd, buf);
    if (written !== buf.length) throw new Error(`short write to ${path}: ${written}/${buf.length}`);
  } finally {
    closeSync(fd);
  }
}

export async function appendRoomMessage(dir: string, msg: RoomMessage): Promise<void> {
  if (!isRoomMessage(msg)) throw new Error("not a room message");
  ensureRoomDir(dir);
  await withLocks([dir], () => appendLine(dir, msg));
}

/**
 * Messages from the ledger tail, oldest first. `before`: only messages older than that id (in file
 * order); `limit`: the newest `limit` of those. Lines that do not parse are skipped.
 */
export async function readRoom(
  dir: string,
  options: { before?: string; limit?: number; tailBytes?: number } = {},
): Promise<{ messages: RoomMessage[]; truncated: boolean }> {
  const { lines, cut } = await readTailLines(join(dir, ROOM_FILE), options.tailBytes ?? TAIL_BYTES);
  let messages: RoomMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (isRoomMessage(parsed)) messages.push(normalizeParties(parsed));
    } catch {
      // torn or foreign line
    }
  }
  let older = cut;
  if (options.before) {
    const at = messages.findIndex((m) => m.id === options.before);
    messages = at >= 0 ? messages.slice(0, at) : [];
  }
  if (options.limit !== undefined && messages.length > options.limit) {
    messages = messages.slice(messages.length - options.limit);
    older = true;
  }
  return { messages, truncated: older };
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write (temp file + rename), mode 0600. */
export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
