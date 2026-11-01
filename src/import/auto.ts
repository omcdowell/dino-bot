/**
 * Background import, for onboarding: the bot is already chatting while its old history is summarised.
 *
 * Everything is staged in `<profile>/imports/background/`, a directory shaped like a profile of its own, so the live
 * profile never sees a pending import (which would pause the bot). The runner:
 * - start: stages the imported entries plus the live log as it is now (rebuild mode: one chronological log);
 * - run: builds the summary tree with the import compactor; resumable (finished nodes are files), pausable (abort),
 *   and it stops cleanly at the first rate-limit answer, recording when to try again;
 * - finish: called by the process that holds the profile lock with its memory closed (the bot between turns):
 *   copies messages the bot logged since start onto the end of the new log, moves the generation into the profile
 *   and swaps active-memory.json. The old generation stays on disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { record } from '../cache.ts';
import { atomicWrite, records, isEntry, type Compressor, type Entry } from '../memory.ts';
import { BUSY, failureOf } from '../provider-error.ts';
import {
  importReady,
  memoryDirectory,
  pendingImport,
  prepareImport,
  runImport,
  discardImport,
  type ImportJob,
  type ImportProgress,
} from './job.ts';
import type { ImportedEntry } from './sources.ts';

export const backgroundDir = (dir: string) => join(dir, 'imports', 'background');
const stateFile = (dir: string) => join(backgroundDir(dir), 'state.json');
/** How long to wait after a rate limit that gave no Retry-After. Subscription windows reset in hours, not seconds. */
export const DEFAULT_PAUSE_MS = 30 * 60_000;

export interface BackgroundState {
  id: string;
  /** The live generation at start, relative to the profile, and how many of its messages the staged log holds. */
  live: string;
  base: number;
  started: string;
  status: 'running' | 'paused' | 'rate-limited' | 'ready' | 'failed';
  resumeAfter?: string;
  reason?: string;
  progress?: ImportProgress;
}
export function backgroundState(dir: string): BackgroundState | undefined {
  if (!existsSync(stateFile(dir))) return undefined;
  const value: unknown = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  if (!record(value) || typeof value.id !== 'string' || typeof value.live !== 'string' || !Number.isSafeInteger(value.base))
    throw new Error('Invalid background import state.');
  return value as unknown as BackgroundState;
}
const save = (dir: string, state: BackgroundState) => atomicWrite(stateFile(dir), JSON.stringify(state, null, 2) + '\n');

/** The live log, read only: the bot may hold the profile, so no Memory is opened on it. */
function liveLog(dir: string): { directory: string; root: Entry[] } {
  const directory = memoryDirectory(dir);
  const log = existsSync(join(directory, 'main')) ? records(join(directory, 'main'), () => {}) : [];
  if (!log.every(isEntry)) throw new Error('Invalid OptChat log; refusing to import.');
  return { directory, root: (log as Entry[]).sort((a, b) => a.i - b.i) };
}

/** Stages a background import. Returns undefined when every entry is already in memory. */
export function startBackground(dir: string, entries: readonly ImportedEntry[]): BackgroundState | undefined {
  if (backgroundState(dir)) throw new Error('A background import already exists; resume, finish or discard it.');
  const live = liveLog(dir),
    bg = backgroundDir(dir);
  mkdirSync(bg, { recursive: true, mode: 0o700 });
  const job = prepareImport(bg, { root: live.root, directory: bg }, entries, 'rebuild');
  if (!job) {
    rmSync(bg, { recursive: true, force: true });
    return undefined;
  }
  const state: BackgroundState = {
    id: job.id,
    live: relative(dir, live.directory) || '.',
    base: live.root.length,
    started: new Date().toISOString(),
    status: 'paused',
  };
  save(dir, state);
  return state;
}

/** One runner at a time per profile: an exclusive lock file holding the runner's pid; a dead runner's lock is taken over. */
function lockRunner(dir: string): () => void {
  const file = join(backgroundDir(dir), 'runner.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if (!record(error) || error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8'));
      let alive = false;
      try {
        alive = Number.isSafeInteger(pid) && pid > 0 && process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`Another import runner (pid ${pid}) is working on this profile.`);
      rmSync(file, { force: true });
    }
  }
  throw new Error('Could not lock the import runner.');
}

export type RunOutcome = { status: 'ready' } | { status: 'paused' } | { status: 'rate-limited'; resumeAfter: string; reason: string };
/**
 * Builds summaries until done, paused (signal) or rate limited. Safe to call again at any time: finished nodes are
 * kept, so a rerun continues where the last one stopped. Refuses before `resumeAfter` unless `force`.
 */
export async function runBackground(
  dir: string,
  compress: Compressor,
  signal: AbortSignal,
  progress: (p: ImportProgress) => void = () => {},
  { now = Date.now, force = false }: { now?: () => number; force?: boolean } = {},
): Promise<RunOutcome> {
  const state = backgroundState(dir);
  if (!state) throw new Error('No background import.');
  if (state.status === 'ready') return { status: 'ready' };
  if (!force && state.resumeAfter && Date.parse(state.resumeAfter) > now())
    return { status: 'rate-limited', resumeAfter: state.resumeAfter, reason: state.reason ?? 'rate limited' };
  const unlock = lockRunner(dir);
  const stop = new AbortController();
  const abort = () => stop.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let limited: { resumeAfter: string; reason: string } | undefined;
  // The first busy answer stops the run: retrying inside a plan's limit only burns the next window.
  const guarded: Compressor = async (input, callSignal) => {
    try {
      return await compress(input, callSignal);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.status !== undefined && BUSY.has(failure.status) && !limited) {
        limited = {
          resumeAfter: new Date(now() + (failure.retryAfterMs ?? DEFAULT_PAUSE_MS)).toISOString(),
          reason: `${failure.status}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
        };
        stop.abort();
      }
      throw error;
    }
  };
  save(dir, { ...state, status: 'running', resumeAfter: undefined, reason: undefined });
  let last: ImportProgress | undefined;
  try {
    await runImport(backgroundDir(dir), guarded, stop.signal, p => progress((last = p)), false);
    save(dir, { ...state, status: 'ready', resumeAfter: undefined, reason: undefined, progress: last });
    return { status: 'ready' };
  } catch (error) {
    if (limited) {
      save(dir, { ...state, status: 'rate-limited', ...limited, progress: last });
      return { status: 'rate-limited', ...limited };
    }
    if (stop.signal.aborted) {
      save(dir, { ...state, status: 'paused', progress: last });
      return { status: 'paused' };
    }
    save(dir, { ...state, status: 'failed', reason: error instanceof Error ? error.message : String(error), progress: last });
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    unlock();
  }
}

/**
 * Activates a built background import. Call only while holding the profile lock with the profile's Memory closed.
 * Messages logged since start are appended after the imported history (they are newer), and the bot's next load
 * summarises just those.
 */
export function finishBackground(dir: string): ImportJob {
  const state = backgroundState(dir);
  const bg = backgroundDir(dir);
  const job = importReady(bg);
  if (!state || state.status !== 'ready' || !job) throw new Error('The background import is not built yet.');
  const live = liveLog(dir);
  if ((relative(dir, live.directory) || '.') !== state.live)
    throw new Error('Memory changed generation since the import started; discard it.');
  const staged = join(bg, job.target);
  const count = records(join(staged, 'main'), () => {}).length;
  const tail = live.root.slice(state.base).map((e, k) => ({ ...e, i: count + k }));
  if (tail.length) atomicWrite(join(staged, 'main', '001-live.jsonl'), tail.map(e => JSON.stringify(e)).join('\n') + '\n');
  mkdirSync(join(dir, 'memories'), { recursive: true, mode: 0o700 });
  renameSync(staged, join(dir, job.target));
  const done = {
    ...job,
    previous: state.live,
    total: count + tail.length,
    completed: new Date().toISOString(),
    background: true,
    liveTail: tail.length,
  };
  atomicWrite(join(dir, 'imports', `${job.id}.json`), JSON.stringify(done, null, 2));
  atomicWrite(join(dir, 'active-memory.json'), JSON.stringify(job.target));
  rmSync(bg, { recursive: true, force: true });
  return job;
}

/** Drops a background import that is not finished. The live memory is untouched. */
export function discardBackground(dir: string) {
  const bg = backgroundDir(dir);
  if (existsSync(join(bg, 'runner.lock'))) throw new Error('Pause the import runner first.');
  if (pendingImport(bg)) discardImport(bg);
  rmSync(bg, { recursive: true, force: true });
}
export const hasBackground = (dir: string) => existsSync(backgroundDir(dir)) && readdirSync(backgroundDir(dir)).length > 0;
