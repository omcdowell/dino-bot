import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  bytes,
  end,
  flat,
  isEntry,
  isSummary,
  key,
  lineBytes,
  name,
  records,
  start,
  tag,
  Tiling,
  UNBUILT,
  VIEW,
  type Entry,
  type Part,
  type Summary,
} from '../memory.ts';
import { memoryDirectory } from '../import/job.ts';

/** A room block in the main log: a user message headed `[room <group> block …]` (plan §3.6), tagged `room:<group>`. Kept out of everything a room session reads. */
export const isRoomEntry = (entry: Pick<Entry, 'kind' | 'text'>) => tag(entry).startsWith('room:');
export const EXTRACT_BYTES = 32_000;
const OPEN = '<main-memory>\n',
  CLOSE = '</main-memory>',
  OMITTED = '(older lines left out)';

/**
 * A read-only copy of a profile's memory, for a room session. It reads `main/*.jsonl`, `tree/*.jsonl` and `view.json`
 * the way `Memory` does, but never writes: no mkdir, no saved view, no compactor, no lock. The main bot keeps writing
 * while a room session runs, so each call reloads the files if any changed, and records the bot has not finished
 * (a summary past the log's end, a view that runs past it) are skipped instead of refused.
 */
export class MemoryReader {
  root: Entry[] = [];
  tree = new Map<number, Summary>();
  view: Part[] = [];
  private stamp: string | undefined;

  constructor(
    readonly profileDir: string,
    private readonly warn: (s: string) => void = () => {},
  ) {}

  /** The files' names, sizes and mtimes; a change reloads. */
  private fingerprint(dir: string) {
    const parts = [dir];
    for (const sub of ['main', 'tree']) {
      const folder = join(dir, sub);
      if (!existsSync(folder)) continue;
      for (const file of readdirSync(folder)
        .filter(n => n.endsWith('.jsonl'))
        .sort()) {
        const stat = statSync(join(folder, file));
        parts.push(`${sub}/${file}:${stat.size}:${stat.mtimeMs}`);
      }
    }
    const view = join(dir, 'view.json');
    if (existsSync(view)) {
      const stat = statSync(view);
      parts.push(`view:${stat.size}:${stat.mtimeMs}`);
    }
    return parts.join('\n');
  }

  /** Reloads if a file changed since the last call. */
  refresh() {
    const dir = memoryDirectory(this.profileDir),
      stamp = this.fingerprint(dir);
    if (stamp !== this.stamp) {
      this.load(dir);
      this.stamp = stamp;
    }
    return this;
  }

  private load(dir: string) {
    const log = records(join(dir, 'main'), this.warn);
    const entries = log.every(isEntry) ? log.sort((a, b) => a.i - b.i) : undefined;
    if (!entries || entries.some((entry, i) => entry.i !== i)) throw new Error('Invalid/noncontiguous OptChat log.');
    const root = entries.map(value => ({ ...value, size: bytes(`${tag(value)}: ${value.text}`) }));
    const tree = new Map<number, Summary>();
    for (const value of records(join(dir, 'tree'), this.warn)) {
      if (!isSummary(value) || value.l < 0 || value.i < 0 || end(value) > root.length) continue;
      tree.set(key(value), { ...value, size: lineBytes(value.text) });
    }
    this.root = root;
    this.tree = tree;
    const size = (part: Part) => this.node(part)?.size ?? bytes(UNBUILT),
      built = (part: Part) => !!this.node(part);
    // The same view the bot shows (Memory's constructor), kept in memory only.
    const chat = new Tiling(size, VIEW, VIEW / 2),
      saved = this.savedView(dir);
    if (saved) {
      chat.set(saved);
      for (let i = saved.length ? end(saved.at(-1)!) : 0; i < root.length; i++) chat.push({ l: 0, i });
      chat.fit(root.length, built);
    } else
      for (let i = 0; i < root.length; i++) {
        chat.push({ l: 0, i });
        chat.fit(i + 1, built);
      }
    this.view = chat.parts;
  }

  private savedView(dir: string): Part[] | undefined {
    const file = join(dir, 'view.json');
    if (!existsSync(file)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(value)) return undefined;
      const parts: Part[] = [];
      for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(n => Number.isSafeInteger(n) && n >= 0)) return undefined;
        const part = { l: pair[0], i: pair[1] };
        if (start(part) !== (parts.length ? end(parts.at(-1)!) : 0) || end(part) > this.root.length) return undefined;
        if (part.l > 0 && !this.node(part)) return undefined;
        parts.push(part);
      }
      return parts;
    } catch {
      return undefined;
    }
  }

  node(part: Part) {
    return this.tree.get(key(part));
  }
  private room(part: Part) {
    return part.l === 0 && isRoomEntry(this.root[part.i]);
  }
  private line(part: Part) {
    return `${name(part)}|${flat(this.node(part)?.text ?? UNBUILT)}`;
  }

  /**
   * The bot's saved view, merged further with the same `Tiling` until it fits in `maxBytes` (newest lines stay finest),
   * inside `<main-memory>` tags. Heads are `id+n|`, as in the main view, so main_zoom ids match. Room leaves are left
   * out. If merges are not built yet, the oldest lines are dropped instead, so the result never passes `maxBytes`.
   */
  extract(maxBytes = EXTRACT_BYTES) {
    this.refresh();
    const frame = bytes(OPEN) + bytes(CLOSE);
    const size = (part: Part) => (this.room(part) ? 0 : bytes(this.line(part)) + 1);
    if (maxBytes < frame) return '';
    const budget = maxBytes - frame;
    const tiling = new Tiling(size, budget, budget);
    tiling.set([...this.view]);
    tiling.fit(this.root.length, part => !!this.node(part), true);
    let lines = tiling.parts.filter(p => !this.room(p)).map(p => this.line(p));
    let used = lines.reduce((n, l) => n + bytes(l) + 1, 0);
    if (used > budget) {
      // Unbuilt merges: drop the oldest lines, and say so if the note fits.
      const marker = bytes(OMITTED) + 1 <= budget,
        room = budget - (marker ? bytes(OMITTED) + 1 : 0);
      let cut = 0;
      while (cut < lines.length && used > room) used -= bytes(lines[cut++]) + 1;
      lines = marker ? [OMITTED, ...lines.slice(cut)] : lines.slice(cut);
    }
    const body = lines.join('\n');
    return `${OPEN}${body}${body ? '\n' : ''}${CLOSE}`;
  }

  /** As `Memory.zoom`, with room leaves left out. */
  zoom(id: number, n: number) {
    this.refresh();
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
      if (isRoomEntry(entry)) throw new Error(`Message ${id} is room talk; it is not shown here.`);
      return `${id}+0|${tag(entry)}: ${entry.text}`;
    }
    const l = Math.log2(n) - 1,
      i = (2 * id) / n;
    const lines = [0, 1]
      .map(offset => ({ l, i: i + offset }))
      .filter(part => !this.room(part))
      .map(part => {
        const node = this.node(part);
        if (!node) throw new Error('This range is not summarized yet.');
        return `${start(part)}+${2 ** l}|${flat(node.text)}`;
      });
    return lines.length ? lines.join('\n') : '(room talk only)';
  }

  /** As `Memory.search`, without room messages. */
  search(query: string, limit = 20) {
    this.refresh();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('Give one or more search terms.');
    const matches: string[] = [];
    let more = 0;
    for (let id = this.root.length - 1; id >= 0; id--) {
      const entry = this.root[id];
      if (isRoomEntry(entry)) continue;
      const text = flat(entry.text),
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
    this.refresh();
    if (!Number.isSafeInteger(id) || !this.root[id]) throw new Error(`No message ${id}.`);
    return new Date(this.root[id].date).toString();
  }
}
