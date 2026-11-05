import { existsSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Memory, bytes, COMPACTOR_ERRORS, type Entry, type Compressor } from '../memory.ts';
import { atomicWrite } from '../profiles.ts';
import { record } from '../cache.ts';
import type { ImportedEntry } from './sources.ts';

export type ImportMode = 'append' | 'rebuild';
export interface ImportJob {
  id: string;
  mode: ImportMode;
  previous: string;
  target: string;
  created: string;
  added: number;
  skipped: number;
  total: number;
  inputBytes: number;
}
const pendingFile = (dir: string) => join(dir, 'imports', 'pending.json');
/** Written when a background import has built every summary and waits for finishImport. */
export const readyFile = (dir: string) => join(dir, 'imports', 'ready.json');
export const importReady = (dir: string) => {
  const job = pendingImport(dir);
  if (!job || !existsSync(readyFile(dir))) return undefined;
  const ready: unknown = JSON.parse(readFileSync(readyFile(dir), 'utf8'));
  return record(ready) && ready.id === job.id ? job : undefined;
};
function generationPath(dir: string, name: string) {
  if (name !== '.' && !/^memories\/[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid memory generation path.');
  return join(dir, name);
}
export function memoryDirectory(dir: string): string {
  const file = join(dir, 'active-memory.json');
  if (!existsSync(file)) return dir;
  const name: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof name !== 'string') throw new Error('Invalid active memory pointer.');
  const path = generationPath(dir, name);
  if (!existsSync(join(path, 'main'))) throw new Error('Active memory generation is missing.');
  return path;
}
export function pendingImport(dir: string): ImportJob | undefined {
  if (!existsSync(pendingFile(dir))) return undefined;
  const j: unknown = JSON.parse(readFileSync(pendingFile(dir), 'utf8'));
  if (
    !record(j) ||
    typeof j.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(j.id) ||
    !['append', 'rebuild'].includes(String(j.mode)) ||
    typeof j.previous !== 'string' ||
    j.target !== `memories/${j.id}` ||
    typeof j.created !== 'string' ||
    !['added', 'skipped', 'total', 'inputBytes'].every(k => Number.isSafeInteger(j[k]) && Number(j[k]) >= 0)
  )
    throw new Error('Invalid import journal. Refusing to change profile memory.');
  generationPath(dir, j.previous);
  return {
    id: j.id,
    mode: j.mode === 'append' ? 'append' : 'rebuild',
    previous: j.previous,
    target: `memories/${j.id}`,
    created: j.created,
    added: Number(j.added),
    skipped: Number(j.skipped),
    total: Number(j.total),
    inputBytes: Number(j.inputBytes),
  };
}
export function deduplicate(existing: readonly Entry[], incoming: readonly ImportedEntry[]) {
  const receipts = new Set(existing.map(e => e.receipt).filter(Boolean));
  const added: ImportedEntry[] = [];
  let skipped = 0;
  for (const entry of incoming) {
    if (!entry.receipt?.startsWith('import:')) throw new Error('Imported entry has no stable source identity.');
    if (receipts.has(entry.receipt)) {
      skipped++;
      continue;
    }
    receipts.add(entry.receipt);
    added.push(entry);
  }
  return { added, skipped };
}
/** Imported conversations remain contiguous; existing native history is grouped by user turn. */
export function chronological(entries: readonly ImportedEntry[]) {
  const groups = new Map<string, { date: string; entries: ImportedEntry[] }>();
  let native = 0;
  for (const entry of entries) {
    if (!entry.origin && entry.kind === 'user') native++;
    const id = entry.origin ? JSON.stringify([entry.origin.source, entry.origin.conversation]) : `native:${native}`;
    const group = groups.get(id) ?? { date: entry.date, entries: [] };
    group.date = group.date < entry.date ? group.date : entry.date;
    group.entries.push(entry);
    groups.set(id, group);
  }
  // Native history keeps its log order (by i): a steered message is dated when sent, not when it joined the log,
  // so native dates need not rise. Each native group sorts no earlier than the one before it; the sort is stable.
  let floor = '';
  for (const [id, group] of groups)
    if (id.startsWith('native:')) {
      group.date = group.date < floor ? floor : group.date;
      floor = group.date;
    }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date)).flatMap(g => g.entries);
}
/** Call only while holding the profile lock, after closing its old Memory worker. */
export function prepareImport(
  dir: string,
  old: Pick<Memory, 'root' | 'directory'>,
  incoming: readonly ImportedEntry[],
  mode: ImportMode,
): ImportJob | undefined {
  if (pendingImport(dir)) throw new Error('Resume or discard the pending import first.');
  const { added, skipped } = deduplicate(old.root, incoming);
  if (!added.length) return undefined;
  const id = randomUUID(),
    target = `memories/${id}`,
    path = generationPath(dir, target);
  // Append copies existing summaries without changing their indices. Rebuild regenerates every node.
  const all = mode === 'rebuild' ? chronological([...old.root, ...added]) : [...old.root, ...chronological(added)];
  const entries: Entry[] = all.map((e, i) => ({ ...e, i, size: bytes(`${e.kind}: ${e.text}`) }));
  mkdirSync(join(path, 'tree'), { recursive: true, mode: 0o700 });
  atomicWrite(join(path, 'main', '000-import.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (mode === 'append') cpSync(join(old.directory, 'tree'), join(path, 'tree'), { recursive: true });
  const job: ImportJob = {
    id,
    mode,
    previous: relative(dir, old.directory) || '.',
    target,
    created: new Date().toISOString(),
    added: added.length,
    skipped,
    total: entries.length,
    inputBytes: (mode === 'rebuild' ? entries : added).reduce((n, e) => n + bytes(e.text), 0),
  };
  atomicWrite(pendingFile(dir), JSON.stringify(job, null, 2));
  return job;
}
export function discardImport(dir: string) {
  const job = pendingImport(dir);
  if (!job) return;
  if (memoryDirectory(dir) === generationPath(dir, job.target)) throw new Error('Import is already activated; it cannot be discarded.');
  // Remove the journal first: any interruption leaves only an unused staging directory.
  rmSync(pendingFile(dir));
  rmSync(readyFile(dir), { force: true });
  rmSync(generationPath(dir, job.target), { recursive: true, force: true });
}
export interface ImportProgress {
  messages: number;
  total: number;
  summaries: number;
  error?: string;
}
export async function runImport(
  dir: string,
  compress: Compressor,
  signal: AbortSignal,
  progress: (state: ImportProgress) => void = () => {},
  /** false: build the summaries but leave the swap to finishImport, for a background import while the bot runs. */
  activate = true,
): Promise<ImportJob> {
  const job = pendingImport(dir);
  if (!job) throw new Error('No pending import.');
  const path = generationPath(dir, job.target);
  if (!existsSync(join(path, 'main', '000-import.jsonl')))
    throw new Error('Import staging data is missing; original memory remains intact.');
  const memory = new Memory(path, compress, () => {}, undefined, undefined, undefined, join(dir, COMPACTOR_ERRORS));
  const report = () =>
    progress({
      messages: memory.root.length - memory.pending,
      total: memory.root.length,
      summaries: memory.tree.size,
      error: memory.lastError,
    });
  const timer = setInterval(report, 500);
  try {
    report();
    await memory.settle(signal, true);
    signal.throwIfAborted();
    // Close all writers before the single atomic pointer swap. The previous generation stays intact.
    await memory.close();
    if (!activate) {
      atomicWrite(readyFile(dir), JSON.stringify({ id: job.id, built: new Date().toISOString() }) + '\n');
      report();
      return job;
    }
    atomicWrite(join(dir, 'imports', `${job.id}.json`), JSON.stringify({ ...job, completed: new Date().toISOString() }, null, 2));
    atomicWrite(join(dir, 'active-memory.json'), JSON.stringify(job.target));
    rmSync(pendingFile(dir));
    report();
    return job;
  } finally {
    clearInterval(timer);
    await memory.close();
  }
}
