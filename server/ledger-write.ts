/**
 * DM ledger writer: `<bot folder>/dm/inbox.jsonl` and `outbox.jsonl`. The one copy of the writer
 * rules, used by both bot-dm (bin/bot-dm.mjs, run by Node type stripping) and the plugin's
 * `dms.reply` (bundled by the Paseo daemon). Imports carry `.ts` extensions so Node can run it.
 *
 * Writer rules (report 07 §5): append only; one record per line, each line written with a single
 * write() on an O_APPEND descriptor; `dm/` is mode 0700 and the files 0600; a file past 5 MB is
 * renamed to `<name>-YYYY-MM.jsonl` (then `<name>-YYYY-MM.2.jsonl`, … if that exists) before the
 * next append.
 *
 * Locking: every writer holds an exclusive flock(2) on `dm/.lock` while it checks and appends.
 * We lock a separate file, not the jsonl itself, so rotation (a rename) cannot leave a waiting
 * writer holding a lock on the old inode. Node has no flock, so a tiny `sh` child takes the locks
 * with util-linux `flock` and holds them until we close its stdin (or we die).
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  DM_ROTATE_BYTES,
  DmRecordSchema,
  parseLedgerLine,
  type DmMessage,
  type DmRecord,
  type DmStatus,
} from "../shared/dm-schema.ts";

export const LOCK_FILE = ".lock";
export type LedgerFile = "inbox" | "outbox";

/** Create `dir` (and parents) and force it to mode 0700. */
export function ensureDmDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function ledgerPath(dir: string, file: LedgerFile): string {
  return join(dir, `${file}.jsonl`);
}

/** Take exclusive flocks on `<dir>/.lock` for each dir (deduplicated, sorted to avoid deadlock). */
export async function withLocks<T>(
  dirs: string[],
  fn: () => Promise<T> | T,
  timeoutSec = 10,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  const locks = [...new Set(dirs)].sort().map((dir) => {
    ensureDmDir(dir);
    const path = join(dir, LOCK_FILE);
    closeSync(openSync(path, "a", 0o600));
    return path;
  });
  const [command, args] = lockerCommand(locks, timeoutSec, platform);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("locked\n")) resolve();
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`could not lock ${locks.join(", ")} (flock exit ${code})`)));
  });
  try {
    return await fn();
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    await exited;
  }
}

/**
 * The child that holds the locks: it prints `locked` once it has them all and keeps them until its
 * stdin closes. Linux: sh + util-linux `flock`. macOS has no `flock` command, so perl (shipped with
 * macOS) calls flock(2) itself; both take the same kind of lock, so the writers still exclude
 * each other.
 */
function lockerCommand(locks: string[], timeoutSec: number, platform: NodeJS.Platform): [string, string[]] {
  if (platform === "darwin") {
    const script =
      "my $t = shift; my @held;" +
      "for my $p (@ARGV) { open(my $f, '>>', $p) or exit 9; my $end = time + $t;" +
      " until (flock($f, LOCK_EX | LOCK_NB)) { exit 9 if time >= $end; select(undef, undef, undef, 0.05) }" +
      " push @held, $f }" +
      "$| = 1; print \"locked\\n\"; my $ignored = <STDIN>;";
    return ["perl", ["-MFcntl=:flock", "-e", script, String(timeoutSec), ...locks]];
  }
  // fd 3.. per lock; `read` returns when the parent closes stdin or exits.
  const script =
    locks.map((_, i) => `exec ${i + 3}>>"$${i + 1}" && flock -x -w ${timeoutSec} ${i + 3} || exit 9`).join("\n") +
    "\necho locked\nread _ || true\n";
  return ["sh", ["-c", script, "sh", ...locks]];
}

function rotatedName(dir: string, file: LedgerFile, date: Date): string {
  const month = date.toISOString().slice(0, 7);
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? `${file}-${month}.jsonl` : `${file}-${month}.${n}.jsonl`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** Append one record as one line with a single write(). Call only while holding the dir lock. */
export function appendRecord(dir: string, file: LedgerFile, record: DmRecord, now = new Date()): void {
  const path = ledgerPath(dir, file);
  try {
    if (statSync(path).size >= DM_ROTATE_BYTES) renameSync(path, rotatedName(dir, file, now));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const fd = openSync(path, "a+", 0o600);
  try {
    // If a crashed writer left a torn last line, start ours on a fresh line so it still parses.
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

/** Seconds a writer waits for another writer's lock before giving up. */
export const LOCK_WAIT_SECONDS = 10;

/** Validate `record`, then append it to `<dir>/<file>.jsonl` under the dir lock. */
export async function appendLedgerRecord(
  dir: string,
  file: LedgerFile,
  record: DmRecord,
  now = new Date(),
  timeoutSec = LOCK_WAIT_SECONDS,
): Promise<void> {
  const valid = DmRecordSchema.parse(record);
  await withLocks([dir], () => appendRecord(dir, file, valid, now), timeoutSec);
}

/** Parsed records of one ledger file, in file order. Missing file = empty. */
export function readRecords(path: string): DmRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: DmRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parsed = parseLedgerLine(line);
    if (parsed.ok) out.push(parsed.record);
  }
  return out;
}

/** Current file first, then rotated files newest first. */
export function ledgerFiles(dir: string, file: LedgerFile): string[] {
  let rotated: string[] = [];
  try {
    rotated = readdirSync(dir)
      .filter((name) => name.startsWith(`${file}-`) && name.endsWith(".jsonl"))
      .sort(compareRotated)
      .reverse()
      .map((name) => join(dir, name));
  } catch {
    // no dir yet
  }
  return [ledgerPath(dir, file), ...rotated];
}

function compareRotated(a: string, b: string): number {
  const key = (name: string) => {
    const m = /-(\d{4}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(name);
    return m ? `${m[1]}.${String(Number(m[2] ?? 1)).padStart(6, "0")}` : name;
  };
  return key(a).localeCompare(key(b));
}

/** The message record with `id` in the given dir's inbox/outbox (current, then rotated files). */
export function findMessage(dir: string, id: string): DmMessage | null {
  for (const file of ["inbox", "outbox"] as const) {
    for (const path of ledgerFiles(dir, file)) {
      const hit = readRecords(path).find((r): r is DmMessage => r.type === "message" && r.id === id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Last status recorded for `id` in an outbox, or null. */
export function lastStatus(records: DmRecord[], id: string): DmStatus | null {
  let last: DmStatus | null = null;
  for (const r of records) if (r.type === "status" && r.id === id) last = r;
  return last;
}
