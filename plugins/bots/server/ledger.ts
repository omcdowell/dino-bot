import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseLedgerLine, type DmMessage, type DmStatus } from "../shared/dm-schema";

/** How much of each ledger the DMs view reads: the tail, never the whole file. */
export const TAIL_BYTES = 256 * 1024;

export type LedgerName = "inbox" | "outbox";

export interface LedgerRead {
  messages: DmMessage[];
  statuses: DmStatus[];
  /** Broken JSON or known record types failing validation. */
  invalid: number;
  /** Valid JSON of a type or version this reader does not know (skipped silently). */
  unknown: number;
  /** Older lines exist that were not read. */
  truncated: boolean;
}

export const emptyRead = (): LedgerRead => ({ messages: [], statuses: [], invalid: 0, unknown: 0, truncated: false });

/**
 * The last `limit` bytes of `path` as whole lines. A partial first line (cut by the window) is dropped.
 * A last line without a newline may be a write in progress: it is kept only if it parses.
 */
export async function readTailLines(path: string, limit: number): Promise<{ lines: string[]; size: number; cut: boolean }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], size: 0, cut: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - limit);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    let text = buffer.subarray(0, read).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    const lines = text.split("\n");
    const last = lines.pop() ?? "";
    if (last.trim() && parseLedgerLine(last).ok) lines.push(last);
    return { lines: lines.filter((line) => line.trim()), size, cut: start > 0 };
  } finally {
    await handle.close();
  }
}

function tally(lines: string[], into: LedgerRead) {
  for (const line of lines) {
    const parsed = parseLedgerLine(line);
    if (parsed.ok) {
      if (parsed.record.type === "message") into.messages.push(parsed.record);
      else into.statuses.push(parsed.record);
    } else into[parsed.reason]++;
  }
}

/** Sort key for bot-dm's rotated names: `inbox-2026-09.jsonl` < `inbox-2026-09.2.jsonl` < `inbox-2026-10.jsonl`. */
function rotatedKey(file: string): string {
  const m = /-(\d{4}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(file);
  return m ? `${m[1]}.${String(Number(m[2] ?? 1)).padStart(6, "0")}` : file;
}

/** Rotated siblings of `<name>.jsonl`, oldest first. */
export async function rotatedFiles(dir: string, name: LedgerName): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(`${name}-`) && entry.endsWith(".jsonl"))
    .sort((a, b) => rotatedKey(a).localeCompare(rotatedKey(b)))
    .map((entry) => join(dir, entry));
}

/** Newest rotated sibling, or null. */
export async function newestRotated(dir: string, name: LedgerName): Promise<string | null> {
  const rotated = await rotatedFiles(dir, name);
  return rotated[rotated.length - 1] ?? null;
}

/** Reads the tail of `<dir>/<name>.jsonl`, topping up from the newest rotated file when the live one is short. */
export async function readLedger(dir: string, name: LedgerName, limit = TAIL_BYTES): Promise<LedgerRead> {
  const result = emptyRead();
  const live = await readTailLines(join(dir, `${name}.jsonl`), limit);
  if (live.cut) result.truncated = true;
  else if (live.size < limit) {
    const rotated = await rotatedFiles(dir, name);
    const newest = rotated[rotated.length - 1];
    if (newest) {
      const older = await readTailLines(newest, limit - live.size);
      tally(older.lines, result);
      // Anything in older rotations, or cut from this one, was not read.
      if (older.cut || rotated.length > 1) result.truncated = true;
    }
  }
  tally(live.lines, result);
  return result;
}

/**
 * Caches parsed ledgers by file identity, so a 30-second sidebar poll over every bot re-reads only
 * files that changed. Keyed on the live file's size and mtime plus the rotated file's name.
 */
export class LedgerCache {
  private readonly entries = new Map<string, { key: string; read: LedgerRead }>();
  constructor(private readonly limit = TAIL_BYTES) {}

  async read(dir: string, name: LedgerName): Promise<LedgerRead> {
    const path = join(dir, `${name}.jsonl`);
    let key: string;
    try {
      const info = await stat(path);
      key = `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      key = "missing";
    }
    key += `|${(await newestRotated(dir, name)) ?? ""}`;
    const cached = this.entries.get(path);
    if (cached && cached.key === key) return cached.read;
    const read = await readLedger(dir, name, this.limit);
    this.entries.set(path, { key, read });
    return read;
  }
}
