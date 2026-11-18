/**
 * The turn lifecycle over an OptChat profile, shared by both engines that run a bot: pi (controller.ts, from pi's
 * extension events) and Claude Code (the DinoBot bots plugin's server/cc/engine.ts, from its mods' HTTP calls).
 *
 * open (lock, memory) → between turns (room talk, resummarised lines) → start a run → write each message as it ends →
 * end the run (log, room talk handed over during it, git checkpoint) → close. Each engine keeps only what its host
 * makes different: how input arrives (pi's input event and journal, or typed into the TUI) and how a run is driven.
 *
 * No pi package is imported here (types included): the bots plugin type-checks and loads this file.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { COMPACTOR_ERRORS, Memory, type Compressor } from './memory.ts';
import { lockProfile } from './lock.ts';
import { memoryDirectory } from './import/active.ts';
import { escalator, type Run } from './escalation.ts';
import { escalateTo } from './user.ts';
import { checkpoint } from './checkpoint.ts';
import { applyRoomBlocks } from './room/blocks.ts';
import { RunLog, type LogMessage } from './run-log.ts';
import { sharedPrompt } from './prompts.ts';
import { botSection } from './bot-prompt.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';

export { readSettings, type Settings } from './settings.ts';
export { CompactorError } from './provider-error.ts';
export { task } from './compaction-task.ts';
export { viewBlocks } from './cache.ts';
export { compactorPrompt } from './prompts.ts';
export { bytes, cap, NODE, VIEW, Memory, type Compression, type Kind } from './memory.ts';

export interface TurnsOptions {
  compress: Compressor;
  warn: (s: string) => void;
  /** The bot's environment: a bot (PASEO_AGENT_ID) escalates refused lines with bot-dm, a terminal session does not. */
  env?: () => NodeJS.ProcessEnv;
  /** How bot-dm runs (default: escalation.ts's). */
  send?: Run;
  /** Most compactions at once (default: Memory's). */
  parallel?: number;
}

/** One profile's open memory and its runs: what pi's controller and the Claude Code engine both do with it. */
export class Turns {
  private log: RunLog | undefined;
  private checkpoints = Promise.resolve();

  private constructor(
    readonly dir: string,
    readonly memory: Memory,
    private readonly unlock: () => Promise<void>,
    private readonly warn: (s: string) => void,
  ) {}

  /**
   * Takes the profile lock (a busy profile rejects with lock.ts's ProfileBusyError; `owner` is who holds it, as another
   * process is told), then, under it, `setup` and the profile's active memory.
   */
  static async open(dir: string, owner: string, setup: () => TurnsOptions): Promise<Turns> {
    const unlock = await lockProfile(dir, owner);
    let memory: Memory | undefined;
    try {
      const o = setup();
      const env = o.env ?? (() => process.env);
      memory = new Memory(
        memoryDirectory(dir),
        o.compress,
        o.warn,
        undefined,
        o.parallel,
        undefined,
        join(dir, COMPACTOR_ERRORS),
        env().PASEO_AGENT_ID ? escalator(basename(dir), o.send, () => escalateTo(env())) : undefined,
      );
      return new Turns(dir, memory, unlock, o.warn);
    } catch (error) {
      await memory?.close();
      await unlock();
      throw error;
    }
  }

  /** Room talk handed over while the bot was busy (never mid-run); returns how many blocks went in. */
  roomBlocks(): number {
    return applyRoomBlocks(this.memory, this.dir, this.warn);
  }

  /** Before a turn, while no run is open: room talk, then lines replaced with the resummarise CLI. */
  between(): number {
    const n = this.roomBlocks();
    this.memory.applyRequests();
    return n;
  }

  /** A new run's log; whatever the last run left unwritten goes first. */
  start(digest: boolean) {
    this.log?.end();
    this.log = new RunLog(this.memory, digest, join(this.dir, 'images'));
  }

  /** One message of the run, as it ended; `receipt` marks the input journal entry it answers. */
  write(message: LogMessage, receipt?: string) {
    (this.log ??= new RunLog(this.memory, false, join(this.dir, 'images'))).write(message, receipt);
  }

  /** Writes what the run's log still holds (a tool digest, a repeated error). */
  flush() {
    this.log?.end();
  }

  /** The run is over: its log ends, room talk handed over during it goes in, and the profile is committed. */
  end(): Promise<void> {
    this.flush();
    this.log = undefined;
    this.roomBlocks();
    return this.checkpoint();
  }

  /** A git commit of the profile (checkpoint.ts), one after another. */
  checkpoint(): Promise<void> {
    const dir = this.dir;
    return (this.checkpoints = this.checkpoints
      .then(() => checkpoint(dir))
      .catch(error => this.warn(`Local checkpoint failed: ${error instanceof Error ? error.message : String(error)}`)));
  }

  /** Waits for the checkpoints already started. */
  settled(): Promise<void> {
    return this.checkpoints;
  }

  async close() {
    try {
      this.flush();
      await this.memory.close();
      await this.checkpoint();
    } finally {
      await this.memory.close();
      await this.unlock();
    }
  }
}

/**
 * The parts of a bot's system prompt that do not depend on the engine, in pi-optchat's order: OptChat's rules, the
 * host's section (the bots plugin's), the profile's AGENTS.md (last: it changes most often), with the import guidance
 * once memory holds imported history. `compactions`: whether compactions send this prompt (pi only).
 */
export function promptParts(dir: string, memory: Memory, continuity: boolean, env: NodeJS.ProcessEnv, compactions: boolean) {
  let agents = '';
  try {
    agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  } catch {}
  return {
    custom: sharedPrompt(continuity, env, compactions),
    bot: botSection(env),
    instructions: memory.hasImported() ? `${agents}\n\n${IMPORT_GUIDANCE}` : agents,
  };
}

/** The runner for bot-dm a host without `escalation.ts`'s default wants (the bots plugin: the bot's environment). */
export const sendWith =
  (env: () => NodeJS.ProcessEnv): Run =>
  (file, args) =>
    new Promise<void>((resolve, reject) => execFile(file, args, { env: env(), timeout: 30_000 }, error => (error ? reject(error) : resolve())));
