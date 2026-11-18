import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  getAgentDir,
  parseSkillBlock,
  type BeforeAgentStartEvent,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Memory } from './memory.ts';
import { withoutGlobalContext } from './context-files.ts';
import { createCompressor, type ModelChoice } from './compactor.ts';
import { liveCompactor, loadConfig, profilePath, rememberProfile, type ProfileConfig } from './profiles.ts';
import { allowedSkills, skillPolicy } from './skills.ts';
import { TurnPrefix } from './cache.ts';
import { parseFailure } from './provider-error.ts';
import { asUser, boundedMessage, buildContext, previousExchange, RUN_BOUNDARY, textContent, typedText } from './transcript.ts';
import { Inbox } from './inbox.ts';
import { pendingImport } from './import/job.ts';
import { UsageLedger } from './usage.ts';
import { mainTitle, TabTitle } from './title.ts';
import { promptParts, Turns } from './turn.ts';

/**
 * The run log's end entry. A run that ended on a provider error also records it: the status and, when the error
 * message gives it away, the Retry-After. Pi drops a failed response's headers, so that is often unknown.
 */
export function runEnd(run: readonly AgentMessage[], now = Date.now()) {
  const last = run.findLast(m => m.role === 'assistant');
  if (last?.role !== 'assistant' || last.stopReason !== 'error') return { state: 'end' };
  const message = last.errorMessage ?? 'No further details',
    { status, retryAfterMs } = parseFailure(message);
  return {
    state: 'end',
    error: {
      message: message.slice(0, 500),
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined
        ? { retryAfter: Math.round(retryAfterMs / 1000), retryAt: new Date(now + retryAfterMs).toISOString() }
        : {}),
    },
  };
}
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** An open profile: its memory and runs (turn.ts, which holds the lock), input journal and usage ledger. */
export interface OpenProfile {
  name: string;
  dir: string;
  config: ProfileConfig;
  /** The compactor model as config.json has it now. */
  compactor: () => ModelChoice;
  memory: Memory;
  turns: Turns;
  inbox: Inbox;
  usage: UsageLedger;
}

/**
 * The per-session state machine. Each run starts from a fresh context: the memory view rendered before the new
 * input, the previous exchange, and the run's own messages. Every message is written to memory as it ends.
 */
export class SessionController {
  active: OpenProfile | undefined;
  /** Set while an import runs; chat and profile changes wait for it. */
  importing = false;
  /** A failure that makes the next turn unsafe (e.g. memory could not be written). */
  fault: string | undefined;
  private run: AgentMessage[] = [];
  private previous: AgentMessage[] = [];
  private logged = 0;
  private view: string | undefined;
  private prompt = '';
  private runStarted = false;
  private working = false;
  private readonly receipts = new Map<AgentMessage, string>();
  private readonly title = new TabTitle();

  constructor(
    private readonly pi: ExtensionAPI,
    /** The last turn's tools and system prompt, which compactions reuse. */
    readonly turnPrefix = new TurnPrefix(),
  ) {}

  required() {
    if (!this.active) throw new Error('Choose an OptChat profile first: /optchat profile');
    return this.active;
  }

  status(ctx: ExtensionContext) {
    const a = this.active;
    const importState = !a ? '' : this.importing ? ' · importing' : pendingImport(a.dir) ? ' · import paused: /optchat import' : '';
    ctx.ui.setStatus(
      'optchat',
      a ? `OptChat: ${a.name} · ${a.memory.root.length} messages · ${a.memory.pending} pending${importState}` : 'OptChat: choose profile',
    );
  }

  showTitle(ctx: ExtensionContext) {
    if (this.active) this.title.show(text => ctx.ui.setTitle(text), mainTitle(this.active.name, this.working));
  }
  reapplyTitle() {
    this.title.reapply();
  }

  collectUsage(ctx: ExtensionContext) {
    try {
      this.active?.usage.backfill(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    } catch (error) {
      ctx.ui.notify(`Could not save usage: ${errorText(error)}`, 'error');
    }
  }

  /** Writes every message of the current run that memory has not seen yet. */
  flush() {
    const a = this.active;
    if (!a) return;
    while (this.logged < this.run.length) {
      const message = this.run[this.logged];
      const receipt = this.receipts.get(message);
      a.turns.write(message, receipt);
      this.logged++;
      if (receipt) a.inbox.acknowledge(receipt);
      this.receipts.delete(message);
    }
  }
  /** Flushes the run, including its pending tool digest. */
  private finishLog() {
    this.flush();
    this.active?.turns.flush();
  }

  async open(name: string, ctx: ExtensionContext) {
    const dir = profilePath(name);
    if (!existsSync(dir)) throw new Error(`Profile ${name} does not exist. Use /optchat profile to create it.`);
    let config: ProfileConfig, usage: UsageLedger, liveChoice: () => ModelChoice;
    const turns = await Turns.open(dir, `${name} · PID ${process.pid} · ${hostname()} · ${ctx.cwd}`, () => {
      config = loadConfig(dir);
      const sessionId = ctx.sessionManager.getSessionId();
      usage = new UsageLedger(dir);
      usage.backfill(ctx.sessionManager.getEntries(), sessionId);
      liveChoice = liveCompactor(dir, config);
      const compress = createCompressor(
        ctx.modelRegistry,
        liveChoice,
        message => {
          usage.compression(message, 'compactor', sessionId);
          this.status(ctx);
        },
        () => config.summaryAcceptBytes,
        this.turnPrefix,
      );
      return { compress, warn: warning => ctx.ui.notify(warning, 'error') };
    });
    const memory = turns.memory;
    try {
      const inbox = new Inbox(dir);
      const recovered = pendingImport(dir) ? 0 : inbox.recover(memory);
      if (recovered)
        ctx.ui.notify(`Recovered ${recovered} unanswered inputs into ${name}'s memory. Ask to continue them when ready.`, 'info');
      rememberProfile(name);
      this.active = { name, dir, config: config!, compactor: liveChoice!, memory, turns, inbox, usage: usage! };
      this.fault = undefined;
      this.showTitle(ctx);
      this.status(ctx);
      const { compactor } = config!;
      ctx.ui.notify(
        `OptChat · ${name} · ${memory.root.length} messages\nCompactor: ${compactor.provider}/${compactor.model} (${compactor.thinking})`,
        'info',
      );
    } catch (error) {
      if (this.active?.memory === memory) this.active = undefined;
      await turns.close();
      throw error;
    }
  }

  async close() {
    const a = this.active;
    if (!a) return;
    try {
      this.finishLog();
      if (!pendingImport(a.dir)) a.inbox.recover(a.memory);
    } finally {
      await a.turns.close();
      this.active = undefined;
      this.run = [];
      this.previous = [];
      this.logged = 0;
      this.view = undefined;
      this.runStarted = false;
      this.receipts.clear();
      this.prompt = '';
      this.title.clear();
      this.working = false;
    }
  }

  /** Journals typed input before the turn, so a crash before it reaches memory can recover it. */
  input(text: string, source: string, ctx: ExtensionContext): 'continue' | 'handled' {
    const a = this.active;
    if (!a) {
      ctx.ui.notify(this.fault ?? 'Select a profile with /optchat profile before chatting.', 'error');
      return 'handled';
    }
    if (this.importing || pendingImport(a.dir)) {
      ctx.ui.notify('This profile has an import in progress. Use /optchat import to resume or discard it, or switch profiles.', 'info');
      return 'handled';
    }
    if (source === 'extension') return 'continue';
    try {
      a.inbox.record(text);
    } catch (error) {
      ctx.ui.notify(`Could not save input: ${errorText(error)}`, 'error');
      return 'handled';
    }
    return 'continue';
  }

  private startRun(ctx: ExtensionContext) {
    this.flush();
    this.active?.turns.start(!!this.active.config.toolDigest);
    this.run = [];
    this.logged = 0;
    this.view = undefined;
    this.runStarted = true;
    const config = this.active?.config;
    this.previous = config?.previousExchange ? previousExchange(ctx.sessionManager.getBranch(), config.previousExchangeKB * 1000) : [];
    this.pi.appendEntry(RUN_BOUNDARY, { state: 'start' });
  }

  beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
    this.startRun(ctx);
    const a = this.required();
    // Pi's own prompt sections (project AGENTS.md files, the bot's skills, cwd) stay; the profile's instructions go last.
    // The user's global AGENTS.md files are for interactive sessions, not bots, so they are dropped.
    event.systemPromptOptions.contextFiles = withoutGlobalContext(event.systemPromptOptions.contextFiles, getAgentDir());
    // Likewise the user's global skills, except those the profile lists; the profile may also hide any skill (skills.ts).
    event.systemPromptOptions.skills = allowedSkills(event.systemPromptOptions.skills, skillPolicy(a.dir));
    // The compaction rules only serve compactions that send this prompt: those on the turn's own provider and model.
    const c = a.compactor();
    const compactions = !ctx.model || (c.provider === ctx.model.provider && c.model === ctx.model.id);
    // A bot's host rules (bots plugin), before its own AGENTS.md, which changes more often and so stays last; the import
    // guidance only once the memory holds imported history (turn.ts).
    const parts = promptParts(a.dir, a.memory, a.config.previousExchange, process.env, compactions);
    event.systemPromptOptions.customPrompt = parts.custom;
    delete event.systemPromptOptions.sections.instructions;
    if (parts.bot) event.systemPromptOptions.sections.bot = parts.bot;
    event.systemPromptOptions.sections.instructions = parts.instructions;
    this.prompt = event.systemPrompt;
  }

  /** A run another extension starts while Pi is idle skips before_agent_start; it still gets a run of its own. */
  agentStart(ctx: ExtensionContext) {
    this.working = true;
    this.showTitle(ctx);
    if (this.active && !this.runStarted) this.startRun(ctx);
  }

  messageEnd(original: AgentMessage, ctx: ExtensionContext): AgentMessage | undefined {
    const a = this.active;
    if (!a || !this.runStarted) return undefined;
    const bounded = boundedMessage(original);
    const message = asUser(bounded);
    if (message.role === 'user') {
      try {
        // The inbox journaled the typed input: match without image placeholders or Pi's image notes.
        const text = textContent(message.content);
        const typed = typedText(message.content);
        const skill = parseSkillBlock(typed.bare);
        let receipt =
          a.inbox.claim(typed.text) ?? a.inbox.claim(typed.bare) ?? (skill ? a.inbox.claimSkill(skill.name, skill.userMessage) : undefined);
        if (!receipt) {
          a.inbox.record(text);
          receipt = a.inbox.claim(text);
        }
        if (receipt) this.receipts.set(message, receipt);
      } catch (error) {
        this.fail(error, ctx);
      }
    }
    this.run.push(message);
    if (this.view !== undefined) {
      try {
        this.flush();
      } catch (error) {
        this.fail(error, ctx);
      }
    }
    return bounded !== original ? bounded : undefined;
  }

  async context(event: ContextWithSystemEvent, ctx: ExtensionContext): Promise<{ messages: AgentMessage[] }> {
    try {
      const a = this.required();
      if (this.importing || pendingImport(a.dir)) throw new Error('Profile is unavailable while importing.');
      if (this.fault) throw new Error(this.fault);
      if (this.view === undefined) {
        // Group chat talk handed over while the bot was idle, and lines resummarised meanwhile: before the new input.
        if (a.turns.between()) this.status(ctx);
        ctx.ui.setWorkingMessage('Waiting for OptChat summaries…');
        try {
          await a.memory.settle(ctx.signal);
        } finally {
          ctx.ui.setWorkingMessage();
        }
        this.view = a.memory.render(); // Capture old history before logging the new input.
        this.flush();
      }
      return { messages: buildContext(event.messages, this.run, this.view, this.prompt, this.previous) };
    } catch (error) {
      // Pi catches extension errors. Explicitly abort so it cannot fall back to old context.
      ctx.abort();
      try {
        this.flush();
      } catch (persistenceError) {
        this.fault = errorText(persistenceError);
      }
      ctx.ui.notify(errorText(error), 'error');
      return { messages: [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    }
  }

  async agentSettled(ctx: ExtensionContext) {
    this.collectUsage(ctx);
    try {
      this.finishLog();
    } catch (error) {
      this.fault = errorText(error);
      ctx.ui.notify(this.fault, 'error');
    }
    if (this.runStarted) this.pi.appendEntry(RUN_BOUNDARY, runEnd(this.run));
    this.runStarted = false;
    this.working = false;
    const a = this.active;
    if (!a) return void this.showTitle(ctx);
    // Group chat talk handed over during the run goes into the log now that it has settled (it never starts a turn);
    // the profile is committed (turn.ts).
    let ended: Promise<void>;
    try {
      ended = !this.fault && !this.importing && !pendingImport(a.dir) ? a.turns.end() : a.turns.checkpoint();
    } catch (error) {
      ctx.ui.notify(`Could not apply room blocks: ${errorText(error)}`, 'error');
      ended = a.turns.checkpoint();
    }
    this.status(ctx);
    this.showTitle(ctx);
    await ended;
  }

  /** Writes what is pending and waits for checkpoints, so memory can be closed for an import. */
  async quiesce() {
    const a = this.required();
    this.finishLog();
    a.inbox.recover(a.memory);
    await a.turns.settled();
  }

  private fail(error: unknown, ctx: ExtensionContext) {
    ctx.abort();
    this.fault = errorText(error);
    ctx.ui.notify(this.fault, 'error');
  }
}
