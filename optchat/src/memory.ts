import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { classify, failureOf, permanentReason } from './provider-error.ts';
import { isUser } from './user.ts';

export const NODE = 512;
/** Once the view passes this many bytes, one batch merges it down to half of it (UniiChat §3.2: 128 KB to 64 KB). */
export const VIEW = 128_000;
export const CAP = 30_000;
/** The longest Retry-After the compactor honours, and its back-off when a busy provider gives none. */
const MAX_RETRY_AFTER = 60 * 60_000;
const MAX_BACKOFF = 15 * 60_000;
/** Tries a node the provider refuses gets before it is built from a fallback line instead. */
const PERMANENT_TRIES = 3;
/** A turn waits through this many failed attempts at a line in its view, then shows the line unsummarized. */
const TURN_WAITS_FOR = 1;
/** Marks a line built without the compactor, so it can be found and rebuilt later. */
export const NOT_SUMMARISED = 'not summarised';
/** A fallback line: a message's `kind (date, n bytes, not summarised: reason)` or a merge's `(not summarised: reason) …`. */
const FALLBACK = /^(?:\S+ \(\d{4}-\d{2}-\d{2}, \d+ bytes, not summarised: ([^)]*)\)$|\(not summarised: ([^)]*)\) )/;
/** The reason a line gives if it is a fallback line, else undefined. */
export const fallbackReason = (text: string) => {
  const match = FALLBACK.exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
};
/** In the memory directory: replacement lines waiting to be applied, one JSON file each (see `resummarise`). */
export const REQUESTS = 'resummarise';
/** What an escalation may say about a node the provider refused: never its text. */
export interface Escalation {
  /** `id+n` */
  node: string;
  /** Why it was not summarised, from `permanentReason`'s fixed vocabulary. */
  reason: string;
  messages: { id: number; kind: string; bytes: number; date: string }[];
}
/** In the profile directory: one JSON line per failed compaction. */
export const COMPACTOR_ERRORS = 'compactor-errors.jsonl';
/** How many messages ahead of the first unsummarized one may be summarized at once. */
const PIPELINE = 8;
export type Kind = 'user' | 'talk' | 'tool' | 'echo' | 'note';
export interface Origin {
  source: 'claude' | 'claude-memory' | 'codex' | 'chatgpt' | 'pi' | 'cursor' | 'gemini';
  conversation: string;
  message: string;
  title: string;
  project?: string;
}
export interface Entry {
  i: number;
  kind: Kind;
  text: string;
  size: number;
  date: string;
  receipt?: string;
  origin?: Origin;
}
export interface Part {
  l: number;
  i: number;
}
export interface Summary extends Part {
  text: string;
  size: number;
}
export interface Compression {
  context: string;
  source: string;
  merge: boolean;
  /** The node being built: a message (l = 0) or the merge of two lines. */
  part?: Part;
  historical?: boolean;
}
export type Compressor = (input: Compression, signal: AbortSignal) => Promise<string>;
export const key = ({ l, i }: Part) => l * 2 ** 40 + i;
export const UNBUILT = '(not summarized yet: zoom it)';
export const start = ({ l, i }: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part.l;
/** A line's name in the view, `id+n`. */
export const name = (part: Part) => `${start(part)}+${2 ** part.l}`;
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
/**
 * The envelope line that bot-dm stamps on a message from another bot or a herdr worker
 * (worker:<name>). Kept in step with bot-dm via test/fixtures/dm-envelopes.jsonl. Any lowercase kind counts, so a
 * kind bot-dm adds later (such as `resume`) is still filed as dm:<from>, never as the user's words.
 */
const DM =
  /^\[dm \S+ from ([a-z0-9][a-z0-9_-]{0,63}|worker:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}) to [a-z0-9][a-z0-9_-]{0,63} kind=[a-z]+ hop=\d+ re=\S+( expects-reply)?\]/;
/**
 * The header of a room block (plan §3.6): group chat talk the paseo-bots plugin hands over to the bot's main memory,
 * `[room <group> block <id> msgs <first>-<last>]`. Only a block counts: a task the user assigns from a room
 * (`[room <group> task from user …]`) is their own message to the main chat and stays `user`.
 */
export const ROOM_BLOCK = /^\[room ([a-z0-9][a-z0-9-]{0,40}) block ([A-Za-z0-9][A-Za-z0-9._-]{0,120}) msgs [^\]\n]*\]/;
/**
 * A task a group's lead bot assigned from a room (paseo-bots `assignmentText`):
 * `[room <group> task from <lead> msg <id>]`. Unlike the user's (`task from user`), it is a request from another
 * bot, so it is filed like a DM from that bot.
 */
export const ROOM_LEAD_TASK = /^\[room [a-z0-9][a-z0-9-]{0,40} task from ([a-z0-9][a-z0-9_-]{0,63}) msg [^\]\n]*\]/;
/**
 * A user message headed by a bot-dm envelope came from another bot: tag it dm:<from>, never user; so does a task
 * a lead bot assigned from a room. A room block is group chat talk: tag it room:<group>, never user, even for
 * the user's lines in it.
 */
export const tag = ({ kind, text }: { kind: Kind; text: string }) => {
  if (kind !== 'user') return kind;
  const dm = DM.exec(text);
  if (dm) return `dm:${dm[1]}`;
  const lead = ROOM_LEAD_TASK.exec(text);
  if (lead && !isUser(lead[1])) return `dm:${lead[1]}`;
  const room = ROOM_BLOCK.exec(text);
  return room ? `room:${room[1]}` : kind;
};
const UNBUILT_BYTES = bytes(UNBUILT);
export const flat = (s: string) => s.replace(/[\r\n]+/g, ' ');
/** `s` cut to at most `limit` UTF-8 bytes, ending in an ellipsis if cut, never in half a character. */
export function cutBytes(s: string, limit: number) {
  if (bytes(s) <= limit) return s;
  return (
    Buffer.from(s)
      .subarray(0, Math.max(0, limit - bytes('…')))
      .toString('utf8')
      .replace(/\uFFFD+$/, '') + '…'
  );
}
export const lineBytes = (s: string) => bytes(flat(s));
const notice = (omitted: number) => `\n[${omitted} characters omitted; head and tail retained]\n`;
const VIEW_OPEN = '<chat>\n';
export const isView = (text: string) => text.startsWith(VIEW_OPEN);
export function cap(text: string, limit = CAP) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - notice(text.length).length) / 2);
  const head = text.slice(0, /[\ud800-\udbff]/.test(text[half - 1]) ? half - 1 : half);
  const tail = text.slice(/[\udc00-\udfff]/.test(text[text.length - half]) ? text.length - half + 1 : text.length - half);
  return head + notice(text.length - head.length - tail.length) + tail;
}
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const otherWriter = (file: string) =>
  new Error(`Another process wrote ${file}. Close every other Pi on this profile and restart Pi; nothing was written.`);
/** With `size`, refuses to append unless the file still has that size. A last line left without its newline is ended first. Returns the new size. */
export function appendJson(file: string, value: unknown, size?: number) {
  const fd = openSync(file, 'a+', 0o600);
  try {
    const length = fstatSync(fd).size,
      last = Buffer.alloc(1);
    if (size !== undefined && length !== size) throw otherWriter(file);
    const torn = length > 0 && readSync(fd, last, 0, 1, length - 1) === 1 && last[0] !== 0x0a;
    const data = Buffer.from((torn ? '\n' : '') + JSON.stringify(value) + '\n');
    if (writeSync(fd, data) !== data.length) throw new Error(`Incomplete write: ${file}`);
    fsyncSync(fd);
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}
export function atomicWrite(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const parent = openSync(dirname(file), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function records(dir: string, warn: (s: string) => void, only?: string): unknown[] {
  if (!existsSync(dir)) return [];
  const result: unknown[] = [];
  for (const name of readdirSync(dir)
    .filter(n => n.endsWith('.jsonl'))
    .sort()) {
    const file = join(dir, name);
    if (only !== undefined && file !== only) continue;
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        result.push(JSON.parse(line));
      } catch {
        warn(`Skipped damaged JSON at ${file}:${index + 1}`);
      }
    }
  }
  return result;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function isEntry(value: unknown): value is Entry {
  return (
    object(value) &&
    Number.isSafeInteger(value.i) &&
    typeof value.kind === 'string' &&
    ['user', 'talk', 'tool', 'echo', 'note'].includes(value.kind) &&
    typeof value.text === 'string' &&
    typeof value.date === 'string'
  );
}
export function isSummary(value: unknown): value is Summary {
  return object(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i) && typeof value.text === 'string';
}

/**
 * The pair of sibling lines to merge next, as an index into `parts`: the most due, `(T + 1) / 2^l - i` (how long ago the
 * pair ended, in its own line size; UniiChat §3.2), oldest first on ties, among pairs `mergeable` allows. -1 if none.
 */
export function mostDue(parts: readonly Part[], total: number, mergeable: (parent: Part) => boolean) {
  let best = -1,
    due = -Infinity;
  for (let j = 0; j + 1 < parts.length; j++) {
    const a = parts[j],
      b = parts[j + 1];
    if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1) continue;
    const age = (total + 1) / 2 ** a.l - a.i;
    if (age > due && mergeable({ l: a.l + 1, i: a.i / 2 })) {
      best = j;
      due = age;
    }
  }
  return best;
}
/**
 * A list of lines that tiles the log, oldest first, with a sawtooth size: each message appends a line, and once the
 * lines pass `high` bytes one batch merges the most due pairs until they are at most `low`. A batch merges only pairs
 * whose parent is built; if it can't reach `low` yet, it goes on at each later fit until it does.
 */
export class Tiling {
  parts: Part[] = [];
  bytes = 0;
  private batching = false;
  constructor(
    private readonly size: (part: Part) => number,
    readonly high: number,
    readonly low: number,
  ) {}
  push(part: Part) {
    this.parts.push(part);
    this.bytes += this.size(part);
  }
  set(parts: Part[]) {
    this.parts = parts;
    this.bytes = parts.reduce((n, p) => n + this.size(p), 0);
  }
  /** A built leaf replaced its placeholder: count its size if this list shows it. */
  resize(part: Part, delta: number) {
    if (this.visible(part)) this.bytes += delta;
  }
  /** The parts tile the log in order, so a binary search finds the part covering a position. */
  visible(part: Part) {
    const at = start(part);
    for (let lo = 0, hi = this.parts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1,
        p = this.parts[mid];
      if (end(p) <= at) lo = mid + 1;
      else if (start(p) > at) hi = mid - 1;
      else return p.l === part.l && p.i === part.i;
    }
    return false;
  }
  /** Returns whether any pair was merged. `force` starts a batch even under `high`. */
  fit(total: number, built: (part: Part) => boolean, force = false) {
    if (this.bytes > this.high || (force && this.bytes > this.low)) this.batching = true;
    let merged = false;
    while (this.batching && this.bytes > this.low) {
      const best = mostDue(this.parts, total, built);
      if (best < 0) break;
      const a = this.parts[best],
        b = this.parts[best + 1],
        parent = { l: a.l + 1, i: a.i / 2 };
      this.bytes += this.size(parent) - this.size(a) - this.size(b);
      this.parts.splice(best, 2, parent);
      merged = true;
    }
    if (this.bytes <= this.low) this.batching = false;
    return merged;
  }
  /** Merges every line that `other` shows coarser, so these lines are never finer than its. Both tile the same log. */
  coarsen(other: readonly Part[]) {
    const parts: Part[] = [];
    for (let j = 0, k = 0, at = 0; j < this.parts.length;) {
      while (k < other.length && end(other[k]) <= at) k++;
      const mine = this.parts[j],
        theirs = other[k];
      const pick = theirs && start(theirs) === at && theirs.l > mine.l ? theirs : mine;
      parts.push(pick);
      at = end(pick);
      while (j < this.parts.length && end(this.parts[j]) <= at) j++;
    }
    if (parts.length !== this.parts.length) this.set(parts);
  }
}

/** The log is authoritative. The tree and monotonically coarsening view follow recipe §§2–6. */
export class Memory {
  readonly root: Entry[] = [];
  private imported = false;
  readonly tree = new Map<number, Summary>();
  /** The chat's view: 64-128 KB of lines, saved to view.json whenever a batch merges. */
  private readonly chat: Tiling;
  /**
   * The compactions' view (UniiChat §4): the chat's view merged further, from 32 KB down to 16 KB, and again whenever
   * the chat's view merges. Compactions read their context from it, so they share one cached prefix.
   */
  private readonly compaction: Tiling;
  /** Merges whose two halves are built, waiting to be built themselves (UniiChat §4: every ready merge is built). */
  private readonly mergeQueue = new Map<number, Part>();
  private readonly events = new EventEmitter();
  private readonly controller = new AbortController();
  private readonly busy = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();
  /** Whether the log holds imported history (entries with an origin, or notes): only then do prompts need the import guidance. */
  hasImported() {
    return (this.imported ||= this.root.some(entry => !!entry.origin || entry.kind === 'note'));
  }
  /** Failed attempts per node since it was last built, by kind; busy answers count only in `all`. */
  private readonly failures = new Map<number, { all: number; transient: number; permanent: number }>();
  /** Nodes the provider kept refusing, with the short reason their fallback line gives. */
  private readonly fallbacks = new Map<number, string>();
  /** Fallback nodes, by `id+n`, escalated (from the error log and this session) or being escalated now. */
  private readonly escalated = new Set<string>();
  private readonly escalating = new Set<Promise<void>>();
  private readonly reported = new Set<number>();
  private readonly lastSeenBytes = new Map<string, number>();
  private leaves = 0;
  /** Per level, every node below this index is built. */
  private readonly low: number[] = [];
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** No compaction starts before this time: the provider said it was busy. */
  private holdUntil = 0;
  /** Busy answers since the last success; while there are any, one compaction runs at a time. */
  private backoffs = 0;
  private scheduled = false;
  private stopped = false;
  lastError?: string;

  constructor(
    readonly directory: string,
    private readonly compress: Compressor,
    private readonly warn: (s: string) => void = console.error,
    readonly budget = VIEW,
    private readonly jobs = 8,
    private readonly retryMs = 10_000,
    /** Each failed compaction is appended here as a JSON line, if set. */
    private readonly errorLog?: string,
    /**
     * Told once about each node built from a fallback line, if set; once it resolves, the error log records
     * `escalated: true` for the node, so a restart does not tell again. Fallback lines not yet escalated (after a crash, or
     * a failed send) are retried at the next start.
     */
    private readonly escalate?: (escalation: Escalation) => Promise<void>,
  ) {
    this.chat = new Tiling(part => this.partBytes(part), budget, budget / 2);
    this.compaction = new Tiling(part => this.partBytes(part), budget / 4, budget / 8);
    for (const sub of ['main', 'tree']) mkdirSync(join(directory, sub), { recursive: true, mode: 0o700 });
    const main = join(directory, 'main'),
      log = records(main, warn);
    for (const name of readdirSync(main).filter(n => n.endsWith('.jsonl')))
      this.lastSeenBytes.set(join(main, name), statSync(join(main, name)).size);
    const entries = log.every(isEntry) ? log.sort((a, b) => a.i - b.i) : undefined;
    if (!entries || entries.some((entry, i) => entry.i !== i)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.');
    for (const value of entries) this.root.push({ ...value, size: bytes(`${tag(value)}: ${value.text}`) });
    for (const value of records(join(directory, 'tree'), warn)) {
      if (!isSummary(value) || value.l < 0 || value.i < 0 || end(value) > this.root.length)
        throw new Error('Invalid OptChat summary record.');
      if (value.l === 0 && !this.tree.has(key(value))) this.leaves++;
      this.tree.set(key(value), { ...value, size: lineBytes(value.text) });
    }
    for (const node of this.tree.values()) this.queueParent(node);
    const saved = this.loadView();
    if (saved) {
      this.chat.set(saved);
      for (let i = saved.length ? end(saved.at(-1)!) : 0; i < this.root.length; i++) this.chat.push({ l: 0, i });
      if (this.chat.fit(this.root.length, part => !!this.node(part))) this.saveView();
    } else {
      // No saved view (a profile from before view.json, or a damaged file): fold the log in order, once, and save it.
      for (let i = 0; i < this.root.length; i++) {
        this.chat.push({ l: 0, i });
        this.chat.fit(i + 1, part => !!this.node(part));
      }
      this.saveView();
    }
    this.compaction.set([...this.chat.parts]);
    this.compaction.fit(this.root.length, part => !!this.node(part), true);
    this.applyRequests();
    if (this.escalate) {
      for (const record of this.errorLog && existsSync(this.errorLog) ? records(dirname(this.errorLog), () => {}, this.errorLog) : [])
        if (object(record) && record.escalated === true && typeof record.node === 'string') this.escalated.add(record.node);
      queueMicrotask(() => this.escalateDue());
    }
    this.schedule();
  }
  get view(): readonly Part[] {
    return this.chat.parts;
  }
  get target() {
    return this.chat.low;
  }
  private get viewFile() {
    return join(this.directory, 'view.json');
  }
  /** The saved view, if it tiles the start of the log with lines that exist; messages logged after it are appended. */
  private loadView(): Part[] | undefined {
    if (!existsSync(this.viewFile)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(this.viewFile, 'utf8'));
      if (!Array.isArray(value)) throw new Error('not a list');
      const parts: Part[] = [];
      for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('bad pair');
        const part = { l: pair[0], i: pair[1] };
        if (start(part) !== (parts.length ? end(parts.at(-1)!) : 0) || end(part) > this.root.length) throw new Error('gap');
        if (part.l > 0 && !this.node(part)) throw new Error(`line ${start(part)}+${2 ** part.l} is not built`);
        parts.push(part);
      }
      return parts;
    } catch (error) {
      this.warn(`Rebuilt the view: ${this.viewFile} is invalid (${error instanceof Error ? error.message : String(error)}).`);
      return undefined;
    }
  }
  private saveView() {
    atomicWrite(this.viewFile, JSON.stringify(this.chat.parts.map(p => [p.l, p.i])) + '\n');
  }
  /** Queues the parent of `part` once both its halves are built. */
  private queueParent(part: Part) {
    const sibling = { l: part.l, i: part.i ^ 1 },
      parent = { l: part.l + 1, i: part.i >> 1 };
    if (this.node(sibling) && !this.node(parent)) this.mergeQueue.set(key(parent), parent);
  }
  private checkLog(next: string) {
    const main = dirname(next),
      names = readdirSync(main).filter(n => n.endsWith('.jsonl'));
    if (names.length !== this.lastSeenBytes.size || names.some(n => statSync(join(main, n)).size !== this.lastSeenBytes.get(join(main, n))))
      throw otherWriter(next);
  }
  append(kind: Kind, text: string, date = new Date().toISOString(), receipt?: string) {
    if (this.stopped) throw new Error('Memory is closed.');
    const entry: Entry = {
      i: this.root.length,
      kind,
      text,
      date,
      size: bytes(`${tag({ kind, text })}: ${text}`),
      ...(receipt ? { receipt } : {}),
    };
    const file = join(this.directory, 'main', `${localDay()}.jsonl`);
    if (!this.lastSeenBytes.has(file)) this.checkLog(file);
    this.lastSeenBytes.set(file, appendJson(file, entry, this.lastSeenBytes.get(file) ?? 0));
    this.root.push(entry);
    this.push(entry.i);
    this.fit();
    this.schedule();
    return entry;
  }
  node(part: Part) {
    return this.tree.get(key(part));
  }
  private text(part: Part) {
    return this.node(part)?.text ?? UNBUILT;
  }
  private partBytes(part: Part) {
    return this.node(part)?.size ?? UNBUILT_BYTES;
  }
  private push(i: number) {
    this.chat.push({ l: 0, i });
    this.compaction.push({ l: 0, i });
  }
  private line(part: Part) {
    return `${name(part)}|${flat(this.text(part))}`;
  }
  render() {
    return `${VIEW_OPEN}${this.view.map(p => this.line(p)).join('\n')}\n</chat>`;
  }
  /**
   * The context of a compaction: the compactions' view up to the node (for a message, the lines before it; for a merge,
   * the lines up to its last message), stopping at the first line not summarized yet.
   */
  compactionView(part: Part) {
    const boundary = part.l === 0 ? start(part) : end(part),
      lines: string[] = [];
    for (const p of this.compaction.parts) {
      if (end(p) > boundary || !this.node(p)) break;
      lines.push(this.line(p));
    }
    return `${VIEW_OPEN}${lines.join('\n')}\n</chat>`;
  }
  get compactionParts(): readonly Part[] {
    return this.compaction.parts;
  }
  get ready() {
    return this.view.every(p => this.node(p));
  }
  get pending() {
    return this.root.length - this.leaves;
  }
  get active() {
    return this.busy.size;
  }
  get size() {
    return this.chat.bytes;
  }
  private fit(total = this.root.length) {
    const built = (part: Part) => !!this.node(part);
    const merged = this.chat.fit(total, built);
    if (merged) {
      this.saveView();
      this.compaction.coarsen(this.chat.parts);
    }
    this.compaction.fit(total, built, merged);
    this.events.emit('change');
  }
  private schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }
  /**
   * Leaves to summarize now, in order: the first PIPELINE messages not summarized yet (UniiChat §4: a message's node
   * starts once fewer than 8 lines before it are unbuilt). Each one's context stops at the first unbuilt line.
   */
  private leavesDue() {
    const due: Part[] = [];
    let low = this.low[0] ?? 0;
    while (this.node({ l: 0, i: low })) low++;
    this.low[0] = low;
    for (let i = low; i < this.root.length && due.length < PIPELINE; i++) if (!this.node({ l: 0, i })) due.push({ l: 0, i });
    return due;
  }
  private pump() {
    if (this.stopped) return;
    // While the provider says it is busy, nothing starts; then one call goes first to see whether it has recovered.
    if (Date.now() < this.holdUntil) return this.wake();
    const jobs = this.backoffs ? 1 : this.jobs;
    for (const part of [...this.leavesDue(), ...this.mergeQueue.values()]) {
      if (this.busy.size >= jobs) break;
      const id = key(part);
      if (this.node(part) || this.busy.has(id) || this.held(part) || (this.retryAt.get(id) ?? 0) > Date.now()) continue;
      const promise = this.build(part, this.fallbacks.get(id))
        .catch(error => {
          if (this.stopped) return;
          this.failed(part, error);
        })
        .finally(() => {
          this.busy.delete(id);
          this.events.emit('change');
          this.schedule();
        });
      this.busy.set(id, promise);
    }
    this.wake();
  }
  /**
   * Records a failed compaction in the profile's error log and schedules its retry. A busy provider (429, 503, 529)
   * holds the whole compactor for its Retry-After (at most an hour), or without one for 10 s, 20 s, 40 s… up to
   * 15 minutes. A transient failure retries that node after 10 s, 20 s, 40 s… up to 15 minutes. A node the provider
   * refuses (see `classify`) is tried twice more, 10 s and 20 s apart, then built from a fallback line without the model.
   */
  private failed(part: Part, error: unknown) {
    const id = key(part),
      node = `${start(part)}+${2 ** part.l}`,
      { status, retryAfterMs } = failureOf(error),
      kind = classify(error),
      count = this.failures.get(id) ?? { all: 0, transient: 0, permanent: 0 },
      now = Date.now();
    count.all++;
    if (kind !== 'busy') count[kind]++;
    this.failures.set(id, count);
    this.lastError = error instanceof Error ? error.message : String(error);
    if (!this.reported.has(id)) {
      this.reported.add(id);
      this.warn(`Compactor ${node}: ${this.lastError}`);
    }
    const busy = kind === 'busy',
      fallback = kind === 'permanent' && count.permanent >= PERMANENT_TRIES;
    if (busy) {
      // Calls that were already running when the hold began fail too; they do not lengthen it again.
      if (now >= this.holdUntil) this.backoffs++;
      const wait =
        retryAfterMs !== undefined
          ? Math.min(retryAfterMs, MAX_RETRY_AFTER)
          : Math.min(this.retryMs * 2 ** (this.backoffs - 1), MAX_BACKOFF);
      this.holdUntil = Math.max(this.holdUntil, now + wait);
    }
    const tries = busy ? 0 : count[kind];
    const retryAt = busy ? this.holdUntil : now + Math.min(this.retryMs * 2 ** (tries - 1), MAX_BACKOFF);
    if (fallback) {
      this.fallbacks.set(id, permanentReason(error));
      this.retryAt.delete(id);
      this.schedule();
    } else this.retryAt.set(id, retryAt);
    if (this.errorLog)
      try {
        appendJson(this.errorLog, {
          time: new Date(now).toISOString(),
          node,
          error: this.lastError,
          ...(status !== undefined ? { status } : {}),
          ...(retryAfterMs !== undefined ? { retryAfter: Math.round(retryAfterMs / 1000) } : {}),
          ...(fallback ? { fallback: true } : { retryAt: new Date(retryAt).toISOString() }),
        });
      } catch (logError) {
        this.warn(`Could not write ${this.errorLog}: ${logError instanceof Error ? logError.message : String(logError)}`);
      }
    this.wake();
  }
  /** Sets a timer for the next retry or the end of a hold, if none is set. */
  private wake() {
    const now = Date.now(),
      deadlines = [...this.retryAt.values(), this.holdUntil].filter(t => t > now);
    if (deadlines.length && !this.retryTimer)
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          this.schedule();
        },
        Math.max(1, Math.min(...deadlines) - now),
      );
  }
  /**
   * A merge with a fallback line as a half waits until the half is replaced (`resummarise`), so the hand-written line,
   * not the fallback, goes into the parent, and a parent that holds no more than the fallback's facts is never built and
   * escalated in turn. The view keeps the fallback and its neighbours as finer lines meanwhile, about one extra line per level.
   */
  private held(part: Part) {
    return (
      part.l > 0 && [0, 1].some(offset => fallbackReason(this.node({ l: part.l - 1, i: 2 * part.i + offset })?.text ?? '') !== undefined)
    );
  }
  /** Tells `escalate` about each fallback line not yet escalated, once. A failed send is retried at the next start. */
  private escalateDue() {
    if (!this.escalate || this.stopped) return;
    for (const node of this.tree.values()) {
      const reason = fallbackReason(node.text),
        id = name(node);
      if (reason === undefined || this.escalated.has(id)) continue;
      this.escalated.add(id);
      const escalation: Escalation = {
        node: id,
        reason,
        messages: this.root
          .slice(start(node), end(node))
          .map(entry => ({ id: entry.i, kind: tag(entry), bytes: entry.size, date: entry.date })),
      };
      const sent = this.escalate(escalation).then(
        () => {
          if (this.errorLog)
            try {
              appendJson(this.errorLog, { time: new Date().toISOString(), node: id, escalated: true });
            } catch (error) {
              this.warn(`Could not write ${this.errorLog}: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
        (error: unknown) => this.warn(`Could not escalate ${id}: ${error instanceof Error ? error.message : String(error)}`),
      );
      this.escalating.add(sent);
      void sent.finally(() => this.escalating.delete(sent));
    }
  }
  /**
   * Replaces a built line with a hand-written one, as the compactor writes lines: appended to today's tree file, which
   * a reload reads after the old one. The tree files are first copied to backups/tree-<time>/. Only a fallback line is
   * replaced unless `force`. Lines already merged from the old one keep its words. Returns the line's old size in bytes.
   */
  resummarise(node: string, text: string, force = false) {
    const match = /^(\d+)\+(\d+)$/.exec(node.trim()),
      id = Number(match?.[1]),
      n = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(id) || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n)
      throw new Error(`No line ${node}: give it as id+n, e.g. 2095+1.`);
    const part = { l: Math.log2(n), i: id / n },
      old = this.node(part);
    if (!old) throw new Error(`Line ${node} is not built yet.`);
    if (!force && fallbackReason(old.text) === undefined)
      throw new Error(`Line ${node} is not a fallback line; add --force to replace it anyway.`);
    const line = flat(text).trim();
    if (!line) throw new Error('The new line is empty.');
    if (bytes(line) > NODE) throw new Error(`The new line is ${bytes(line)} bytes, over the ${NODE}-byte limit.`);
    const tree = join(this.directory, 'tree'),
      backup = join(this.directory, 'backups', `tree-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(tree).filter(f => f.endsWith('.jsonl'))) copyFileSync(join(tree, file), join(backup, file));
    const replaced = { ...part, text: line, size: lineBytes(line) };
    appendJson(join(tree, `${localDay()}.jsonl`), { l: part.l, i: part.i, text: line });
    this.tree.set(key(part), replaced);
    this.escalated.add(name(part));
    this.chat.resize(part, replaced.size - old.size);
    this.compaction.resize(part, replaced.size - old.size);
    this.fit();
    this.schedule(); // Its parent may have been held for it.
    return old.size;
  }
  /**
   * Applies the replacement lines waiting in `<memory>/resummarise/*.json` ({node, text, force?}), oldest first. Each
   * request's outcome is written next to it as `<name>.result` ({ok, error?}) and the request is removed. The bot calls
   * this before every turn; the CLI calls it when it holds the profile lock itself.
   */
  applyRequests() {
    const dir = join(this.directory, REQUESTS);
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()) {
      const path = join(dir, file);
      let result: { ok: boolean; error?: string };
      try {
        const request: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!object(request) || typeof request.node !== 'string' || typeof request.text !== 'string') throw new Error('Invalid request.');
        this.resummarise(request.node, request.text, request.force === true);
        result = { ok: true };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      atomicWrite(`${path.slice(0, -'.json'.length)}.result`, JSON.stringify(result) + '\n');
      rmSync(path, { force: true });
    }
  }
  /**
   * A line made without the model for a node the provider refuses. It holds only facts about the node, never any of
   * its text or its halves' text: the provider refused that text, and it would be sent again in every later turn and
   * compaction that shows the line. A message: `kind (date, n bytes, not summarised: reason)`. A merge:
   * `(not summarised: reason) messages a-b, n bytes, date to date, kinds: …`. Zoom still shows the originals.
   */
  private fallbackLine(part: Part, reason: string) {
    if (part.l === 0) {
      const entry = this.root[part.i];
      return `${tag(entry)} (${entry.date.slice(0, 10)}, ${entry.size} bytes, ${NOT_SUMMARISED}: ${reason})`;
    }
    const entries = this.root.slice(start(part), end(part)),
      kinds = new Map<string, number>();
    for (const entry of entries) kinds.set(tag(entry), (kinds.get(tag(entry)) ?? 0) + 1);
    return cutBytes(
      `(${NOT_SUMMARISED}: ${reason}) messages ${start(part)}-${end(part) - 1}, ${entries.reduce((n, e) => n + e.size, 0)} bytes, ` +
        `${entries[0].date.slice(0, 10)} to ${entries.at(-1)!.date.slice(0, 10)}, kinds: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`,
      NODE,
    );
  }
  private async build(part: Part, fallback?: string) {
    const source =
      part.l === 0
        ? `${tag(this.root[part.i])}: ${this.root[part.i].text}`
        : [0, 1].map(offset => this.text({ l: part.l - 1, i: 2 * part.i + offset })).join('\n');
    const context = this.compactionView(part);
    const mergeSource = part.l > 0 ? [0, 1].map(offset => flat(this.text({ l: part.l - 1, i: 2 * part.i + offset }))).join('\n') : source;
    const text =
      bytes(source) <= NODE
        ? source
        : fallback !== undefined
          ? this.fallbackLine(part, fallback)
          : (
              await this.compress(
                {
                  context,
                  source: mergeSource,
                  merge: part.l > 0,
                  part,
                  historical: this.root.slice(start(part), end(part)).some(entry => !!entry.origin),
                },
                this.controller.signal,
              )
            ).trim();
    if (this.stopped) return;
    if (!text) throw new Error('Compactor returned an empty summary.');
    const node = { ...part, text, size: lineBytes(text) };
    appendJson(join(this.directory, 'tree', `${localDay()}.jsonl`), node);
    this.tree.set(key(part), node);
    this.retryAt.delete(key(part));
    this.failures.delete(key(part));
    this.fallbacks.delete(key(part));
    this.mergeQueue.delete(key(part));
    this.queueParent(part);
    // A leaf is usually still in the view when built, but after a damaged tree file a saved parent can already hide it.
    if (part.l === 0) {
      this.leaves++;
      this.chat.resize(part, node.size - UNBUILT_BYTES);
      this.compaction.resize(part, node.size - UNBUILT_BYTES);
    }
    if (fallback !== undefined) this.escalateDue();
    if (fallback === undefined) this.backoffs = 0;
    if (!this.retryAt.size) this.lastError = undefined;
    this.fit();
  }
  /**
   * Whether a turn may start: every line in the view is built, or has failed more than `TURN_WAITS_FOR` times and is
   * left for its retry. Such a line is shown as the unbuilt placeholder, whose size the view already counts, so one
   * node the provider keeps refusing (or a long outage) never holds the bot's turns.
   */
  get usable() {
    return this.view.every(p => this.node(p) || (this.failures.get(key(p))?.all ?? 0) > TURN_WAITS_FOR);
  }
  /**
   * Waits until a turn may start (`usable`). As in the recipe, the view may run over budget until pending merges land.
   * With `all`, waits instead until every part of the view is built and every merge it currently needs is done.
   */
  async settle(signal?: AbortSignal, all = false): Promise<void> {
    const done = () =>
      all
        ? this.ready && this.busy.size === 0 && !this.leavesDue().length && [...this.mergeQueue.values()].every(p => this.held(p))
        : this.usable;
    if (done()) return;
    if (this.stopped || signal?.aborted) throw new Error('Memory wait cancelled.');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.events.off('change', check);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error('Memory wait cancelled.'));
      };
      const check = () => {
        if (this.stopped) abort();
        else if (done()) {
          cleanup();
          resolve();
        }
      };
      this.events.on('change', check);
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }
  zoom(id: number, n: number) {
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      !Number.isInteger(Math.log2(n)) ||
      id % n ||
      id + n > this.root.length
    )
      throw new Error(`No line ${id}+${n}.`);
    if (n === 1) {
      const entry = this.root[id];
      return `${id}+0|${tag(entry)}: ${entry.text}`;
    }
    const l = Math.log2(n) - 1,
      i = (2 * id) / n;
    return [0, 1]
      .map(offset => {
        const part = { l, i: i + offset },
          node = this.node(part);
        if (!node) throw new Error('This range is not summarized yet.');
        return `${start(part)}+${2 ** l}|${flat(node.text)}`;
      })
      .join('\n');
  }
  /** Originals containing every term (case-insensitive), newest first, as `id+0|kind date: snippet` lines for zoom. */
  search(query: string, limit = 20) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('Give one or more search terms.');
    const matches: string[] = [];
    let more = 0;
    for (let id = this.root.length - 1; id >= 0; id--) {
      const entry = this.root[id],
        text = flat(entry.text),
        lower = text.toLowerCase();
      if (!terms.every(term => lower.includes(term))) continue;
      if (matches.length >= limit) {
        more++;
        continue;
      }
      const at = lower.indexOf(terms[0]),
        from = Math.max(0, at - 120),
        to = Math.min(text.length, at + terms[0].length + 120);
      const snippet = `${from ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
      matches.push(`${id}+0|${tag(entry)} ${entry.date.slice(0, 10)}: ${snippet}`);
    }
    if (!matches.length) return `No messages match "${terms.join(' ')}".`;
    return more ? `${matches.join('\n')}\n(${more} more matches; refine the search)` : matches.join('\n');
  }
  date(id: number) {
    if (!Number.isSafeInteger(id) || !this.root[id]) throw new Error(`No message ${id}.`);
    return new Date(this.root[id].date).toString();
  }
  async close() {
    this.stopped = true;
    this.controller.abort();
    clearTimeout(this.retryTimer);
    this.events.emit('change');
    await Promise.allSettled(this.busy.values());
    await Promise.allSettled(this.escalating);
  }
}
