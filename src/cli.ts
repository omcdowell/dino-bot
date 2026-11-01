/**
 * OptChat's command line: `npm run cli -- resummarise <profile> <id+n> (--text <line> | --file <path|->) [--force]`.
 * Replaces a fallback line (one marked "not summarised") with a hand-written one, safely whether or not the profile's
 * bot is running: the line is queued in the memory directory, and whoever holds the profile lock applies it. If the lock
 * is free, this command takes it and applies the line itself; if a bot holds it, the bot applies it before its next turn.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Memory, REQUESTS, atomicWrite } from './memory.ts';
import { lockProfile, profilePath, ProfileBusyError } from './profiles.ts';
import { memoryDirectory, pendingImport } from './import/job.ts';

const USAGE = 'Usage: npm run cli -- resummarise <profile> <id+n> (--text <line> | --file <path|->) [--force]';

export interface Outcome {
  /** applied: the line is in the tree now. queued: the running bot applies it before its next turn. */
  state: 'applied' | 'queued';
  owner?: string;
}

/** Queues the replacement and applies it if the profile is free. Throws if the replacement was refused. */
export async function resummarise(profile: string, node: string, text: string, force = false, wait = 3000): Promise<Outcome> {
  const dir = profilePath(profile);
  if (!existsSync(dir)) throw new Error(`No profile ${profile}.`);
  if (pendingImport(dir)) throw new Error(`Profile ${profile} is importing; try again when it is done.`);
  const name = `${Date.now()}-${process.pid}`,
    requests = join(memoryDirectory(dir), REQUESTS),
    result = join(requests, `${name}.result`);
  atomicWrite(join(requests, `${name}.json`), JSON.stringify({ node, text, ...(force ? { force } : {}) }) + '\n');
  let owner: string | undefined;
  try {
    const unlock = await lockProfile(dir, `${profile} · resummarise CLI · PID ${process.pid} · ${hostname()}`);
    try {
      // No compactions: jobs = 0. The constructor applies the waiting requests.
      const memory = new Memory(
        memoryDirectory(dir),
        () => Promise.reject(new Error('No compactor in the CLI.')),
        console.error,
        undefined,
        0,
      );
      await memory.close();
    } finally {
      await unlock();
    }
  } catch (error) {
    if (!(error instanceof ProfileBusyError)) throw error;
    owner = error.owner;
  }
  for (const until = Date.now() + (owner ? wait : 0); !existsSync(result) && Date.now() < until;)
    await new Promise(resolve => setTimeout(resolve, 100));
  if (!existsSync(result)) return { state: 'queued', owner };
  const outcome: unknown = JSON.parse(readFileSync(result, 'utf8'));
  rmSync(result, { force: true });
  if (typeof outcome === 'object' && outcome !== null && 'ok' in outcome && outcome.ok === true) return { state: 'applied' };
  throw new Error(
    typeof outcome === 'object' && outcome !== null && 'error' in outcome ? String(outcome.error) : 'The replacement failed.',
  );
}

async function main(args: string[]) {
  const [command, profile, node, ...rest] = args;
  if (command !== 'resummarise' || !profile || !node) throw new Error(USAGE);
  let text: string | undefined,
    force = false;
  for (let k = 0; k < rest.length; k++) {
    if (rest[k] === '--force') force = true;
    else if (rest[k] === '--text' && k + 1 < rest.length) text = rest[++k];
    else if (rest[k] === '--file' && k + 1 < rest.length) text = readFileSync(rest[++k] === '-' ? 0 : rest[k], 'utf8');
    else throw new Error(USAGE);
  }
  if (text === undefined) throw new Error(USAGE);
  const outcome = await resummarise(profile, node, text, force);
  console.log(
    outcome.state === 'applied'
      ? `Replaced line ${node} of ${profile}. The old tree files are in backups/ in its memory directory.`
      : `Queued line ${node} of ${profile}: ${outcome.owner} holds the profile and applies it before its next turn.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
