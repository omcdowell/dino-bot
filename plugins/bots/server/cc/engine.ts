/**
 * OptChat memory for a bot that runs on Claude Code (provider `optchat-cc`).
 *
 * One CcEngine per bot holds the bot's OptChat profile: pi-optchat's own Memory (log, summary tree, view), its
 * profile lock (lock.sock, so a pi chat and a Claude Code chat never share a profile), the inbox journal
 * (pending-inputs.json, pi-optchat's file) and the compaction jobs. The bot's Claude Code TUI runs in herdr with the
 * mods in ../../claude-code/; they reach the engine over loopback HTTP (CcHost) with the bot's own bearer token.
 *
 * Compactions run in the TUI by default: Memory's compressor queues a job, the inbox mod takes it and answers it with
 * `$.model.complete` (the session's own client and login), and posts the line back. Or, per bot or host default
 * (compactor-runner.ts), the host's pi answers it (pi-runner.ts: the pi CLI on the host's pi sign-in, any model pi has),
 * falling back to the TUI when pi fails. DinoBot never calls a model API itself.
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bytes, cap, Memory, NODE, VIEW, type Compression, type Kind } from "pi-optchat/src/memory.ts";
import { lockProfile } from "pi-optchat/src/lock.ts";
import { task } from "pi-optchat/src/compaction-task.ts";
import { viewBlocks } from "pi-optchat/src/cache.ts";
import { compactorPrompt, sharedPrompt } from "pi-optchat/src/prompts.ts";
import { readSettings } from "pi-optchat/src/settings.ts";
import { applyRoomBlocks } from "pi-optchat/src/room/blocks.ts";
import { botSection } from "pi-optchat/src/bot-prompt.ts";
import { IMPORT_GUIDANCE } from "pi-optchat/src/import/guidance.ts";
import { memoryDirectory } from "pi-optchat/src/import/active.ts";
import { escalator } from "pi-optchat/src/escalation.ts";
import { checkpoint } from "pi-optchat/src/checkpoint.ts";
import { RunLog } from "pi-optchat/src/run-log.ts";
import { escalateTo } from "pi-optchat/src/user.ts";
import { CompactorError } from "pi-optchat/src/provider-error.ts";
import { ccBotSkills, formatCcSkills } from "./skills";
import { readSettings as readBotsSettings } from "../settings";
import { parseRunner, resolveRunner, type CompactorRunner, type RunnerWhy } from "./compactor-runner";
import { spawnPiRunner, type PiRunner } from "./pi-runner";
import { anthropicPrice, priceOf, type CcRunUsage, type CcTokens } from "./usage";
import { sameText, transcriptHas, typedText, type CcDelivery } from "./deliver";

/** A compaction the TUI's inbox mod runs with `$.model.complete`. */
export interface CcJob {
  id: string;
  model: string;
  effort?: string;
  maxTokens: number;
  system: string;
  prompt: Array<{ text: string; cache?: boolean }>;
}
export type CcJobResult = { text: string } | { error: string; status?: number; retryAfterMs?: number };

export type CcImage = { data: string; mimeType?: string };

/** A tool's images as the view mod posts them, those with bytes: `{ images }`, or nothing. */
const images = (v: unknown): { images?: CcImage[] } => {
  const list = (Array.isArray(v) ? v : []).flatMap((i): CcImage[] =>
    i && typeof i.data === "string" && i.data ? [typeof i.mimeType === "string" && i.mimeType ? { data: i.data, mimeType: i.mimeType } : { data: i.data }] : [],
  );
  return list.length ? { images: list } : {};
};

/** What the mods report about the session, for the app's timeline. */
export type CcEvent =
  /** origin: Claude Code's origin kind of a turn the TUI started itself (`composer` typed, `task-notification`…). */
  | { type: "started"; id: string | null; text: string; origin?: string }
  /**
   * A prompt Claude Code put into the running turn (a background task's notice that came mid-turn, text typed over the
   * turn): no turn of its own; the running turn's end ends it.
   */
  | { type: "into"; text: string; origin?: string }
  /** partial: the step's answer so far (it streams); the step's last one is whole. */
  | { type: "step"; answer: string; partial?: boolean }
  /** A thinking block of a step, the whole of it so far (`block` names it: turn, step, block index), sent as it grows. */
  | { type: "thinking"; block: string; text: string }
  /** images: what the tool returned as images (base64 or a data URL), for the app's chat image store. */
  | { type: "tool"; phase: "running" | "done"; id: string; name: string; input?: unknown; output?: string; isError?: boolean; images?: CcImage[] }
  /** reason: Claude Code's (`answer`, `aborted`, `refusal`, `error`); `detail`: the refusal's explanation or the error's text. */
  | { type: "complete"; aborted: boolean; reason: string | null; detail?: string }
  | { type: "session"; restarted: boolean }
  /** The TUI's figures so far (server/cc/usage.ts): context, Claude Code's cost, tokens, rate limits. */
  | { type: "usage"; usage: CcRunUsage }
  /** A cost Claude Code does not count: a compaction's `$.model.complete` (`costUsd` null: no price known). */
  | { type: "extra-usage"; tokens: CcTokens; costUsd: number | null; model: string | null }
  /** An inbox item typed just as a turn of the TUI's own started: Claude Code put it into that turn, which answered it. */
  | { type: "merged"; id: string }
  /** An inbox item the TUI never took (typed and not seen, too often): it leaves the inbox. */
  | { type: "undelivered"; id: string; reason: string }
  /** The TUI waits on a permission prompt or a question in its terminal: inbox items wait too. */
  | { type: "blocked"; since: number }
  /** A warning of the bot's memory or its compactions (also in the daemon log): pi-optchat shows them in the chat. */
  | { type: "warning"; text: string };

interface InboxItem {
  id: string;
  /** Normalised as typed (deliver.ts typedText), so the receipt match holds. */
  text: string;
  date: string;
  state?: "queued" | "delivering" | "submitted";
  /** Times typed into the TUI. */
  typed?: number;
}

export interface CcEngineOptions {
  /** The bot's environment (user name, bot prompt file): the turn and compaction prompts read it. */
  env?: NodeJS.ProcessEnv;
  warn?: (s: string) => void;
  /** Most compaction jobs handed to the TUI at once. */
  parallel?: number;
  /** The bot's folder (~/bots/<bot>): its own skills (`.agents/skills`). */
  botDir?: string;
  /** The bots plugin's shared skills (plugins/bots/skills), listed in the prompt as for a pi bot. */
  skillsDir?: string;
  /** The pi runner (default: spawn the host's pi CLI). */
  pi?: PiRunner;
  /** The host's default compactor runner (default: bots settings `compactorRunner`, read at each summary). */
  hostRunner?: () => CompactorRunner | null;
  /** How long pi is left alone after it failed (default 5 min); summaries run in-session meanwhile. */
  piRestMs?: number;
  /** The bot's TUI, which the engine types messages into (launch.ts herdrDelivery). None: messages wait. */
  delivery?: CcDelivery;
  /** No ack (the mods' prompt.submit hook) this long after typing: look in the transcript, then type again. */
  ackMs?: number;
  /** Times an item is typed before it is given up. */
  maxTyped?: number;
  /** How often the engine looks for an item to type. */
  tickMs?: number;
}

const BUSY_TURN_MS = 30 * 60_000;
const COMPACT_DUE_MS = 120_000;
const JOB_LEASE_MS = 5 * 60_000;
const PI_REST_MS = 5 * 60_000;
const DEFAULT_COMPACTOR = { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" }; // pi-optchat's
const ACK_MS = 8_000;
const MAX_TYPED = 3;
const BACKOFF_MAX_MS = 30_000;

/**
 * The compactor model for `$.model.complete`: the family of the profile's when it is an Anthropic one (Claude Code's
 * alias, `claude-sonnet-5-5` -> `sonnet`, so an id this Claude Code does not know still runs), else `haiku`.
 */
export function compactorModel(dir: string): { model: string; effort?: string } {
  return inSessionModel(readProfileConfig(dir).compactor);
}

function readProfileConfig(dir: string): { compactor: { provider?: unknown; model?: unknown; thinking?: unknown } | undefined; runner: CompactorRunner | null } {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return { compactor: raw?.compactor, runner: parseRunner(raw?.compactorRunner) };
  } catch {
    return { compactor: { ...DEFAULT_COMPACTOR }, runner: null };
  }
}

function inSessionModel(c: { provider?: unknown; model?: unknown; thinking?: unknown } | undefined): { model: string; effort?: string } {
  const anthropic = c?.provider === "anthropic" && typeof c.model === "string" && /^claude-/.test(c.model);
  const t = typeof c?.thinking === "string" ? c.thinking : "";
  const effort = t === "minimal" ? "low" : ["low", "medium", "high", "xhigh", "max"].includes(t) ? t : undefined;
  const family = anthropic ? /(opus|sonnet|haiku)/.exec(c!.model as string)?.[1] : undefined;
  return family ? { model: family, ...(effort ? { effort } : {}) } : { model: "haiku" };
}

export interface CompactorPlan {
  runner: CompactorRunner;
  why: RunnerWhy;
  /** What the pi runner sends: the profile's compactor verbatim (thinking "medium" when it names none). */
  pi: { provider: string; model: string; thinking: string };
  /** What the in-session runner (and a pi fallback) sends: compactorModel(). */
  inSession: { model: string; effort?: string };
}

/** Where the next summary runs and on what (compactor-runner.ts), from the profile's config.json and the host default. */
export function compactorPlan(dir: string, host: CompactorRunner | null): CompactorPlan {
  const { compactor, runner: bot } = readProfileConfig(dir);
  const c = compactor && typeof compactor.provider === "string" && typeof compactor.model === "string" ? compactor : undefined;
  const { runner, why } = resolveRunner({ bot, compactor: c ?? DEFAULT_COMPACTOR, host });
  return {
    runner,
    why,
    pi: c
      ? { provider: c.provider as string, model: c.model as string, thinking: typeof c.thinking === "string" ? c.thinking : "medium" }
      : { ...DEFAULT_COMPACTOR },
    inSession: inSessionModel(c ?? DEFAULT_COMPACTOR),
  };
}

/** The profile's Anthropic compactor model id (`claude-sonnet-5-5`), if it names one: what a job's cost is priced at. */
export function compactorModelId(dir: string): string | undefined {
  try {
    const c = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).compactor;
    return c?.provider === "anthropic" && typeof c.model === "string" && /^claude-/.test(c.model) ? c.model : undefined;
  } catch {
    return "claude-sonnet-5-5"; // pi-optchat's default, as compactorModel
  }
}

/** A posted run report, checked: numbers only where numbers belong. */
export function runUsage(body: any): CcRunUsage | null {
  if (!body || typeof body.run !== "string" || !body.run) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);
  const c = body.context && typeof body.context === "object" ? body.context : {};
  const t = body.tokens && typeof body.tokens === "object" ? body.tokens : undefined;
  const context = { window: n(c.window), tokens: n(c.tokens), estimate: n(c.estimate) };
  return {
    run: body.run.slice(0, 200),
    context: Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined)),
    ...(n(body.costUsd) !== undefined ? { costUsd: n(body.costUsd) } : {}),
    ...(t
      ? {
          tokens: {
            input_tokens: n(t.input_tokens) ?? 0,
            output_tokens: n(t.output_tokens) ?? 0,
            cache_read_input_tokens: n(t.cache_read_input_tokens) ?? 0,
            cache_creation_input_tokens: n(t.cache_creation_input_tokens) ?? 0,
          },
        }
      : {}),
    ...(Array.isArray(body.rateLimits)
      ? {
          rateLimits: body.rateLimits
            .filter((r: any) => r && typeof r.kind === "string" && n(r.percentUsed) !== undefined)
            .slice(0, 8)
            .map((r: any) => ({ kind: r.kind, percentUsed: r.percentUsed, ...(typeof r.resetsAt === "string" ? { resetsAt: r.resetsAt } : {}) })),
        }
      : {}),
  };
}

export class CcEngine {
  readonly token = randomBytes(24).toString("base64url");
  readonly memory: Memory;
  private items: InboxItem[] = [];
  private readonly receipts = new Set<string>();
  private readonly turn = { running: false, since: 0, compactDue: false, endedAt: 0 };
  private readonly jobs = new Map<string, { job: CcJob; takenAt: number; fallbackFrom?: CompactorRunner; done: (r: CcJobResult) => void }>();
  private readonly listeners = new Set<(e: CcEvent) => void>();
  private readonly scan: ReturnType<typeof setInterval>;
  private settings = readSettings({});
  private closed = false;
  private readonly pi: PiRunner;
  /** pi failed: summaries run in-session until then. */
  private piRestUntil = 0;
  private lastPlan: CompactorPlan | null = null;
  private warnedPlan = "";
  /** The item typed and not yet acked; one at a time. */
  private inflight: { item: InboxItem; typedAt: number; deadline: number } | null = null;
  private pumping = false;
  private retryAt = 0;
  private failures = 0;
  private blockedSince = 0;
  private lastWait = "";
  /** The profile's git checkpoints (pi-optchat's checkpoint.ts), one after another. */
  private checkpoints: Promise<void> = Promise.resolve();
  private readonly pumpTimer: ReturnType<typeof setInterval>;

  private constructor(
    readonly bot: string,
    readonly dir: string,
    private readonly unlock: () => Promise<void>,
    private readonly opts: CcEngineOptions,
  ) {
    const warn = (s: string) => this.warn(s);
    this.pi = opts.pi ?? spawnPiRunner();
    this.loadSettings();
    // As pi-optchat's controller opens it: the profile's active memory generation (an import's: active-memory.json), and
    // refused lines escalated with bot-dm, sent from the bot's chat (its PASEO_AGENT_ID); none without one.
    const env = () => this.opts.env ?? process.env;
    const send = (file: string, args: string[]) =>
      new Promise<void>((resolve, reject) => execFile(file, args, { env: env(), timeout: 30_000 }, (error) => (error ? reject(error) : resolve())));
    this.memory = new Memory(
      memoryDirectory(dir),
      (input, signal) => this.compress(input, signal),
      warn,
      VIEW,
      opts.parallel ?? 4,
      10_000,
      join(dir, "compactor-errors.jsonl"),
      env().PASEO_AGENT_ID ? escalator(basename(dir), send, () => escalateTo(env())) : undefined,
    );
    for (const e of this.memory.root) if (e.receipt) this.receipts.add(e.receipt);
    this.loadInbox();
    this.scan = setInterval(() => {
      if (!this.idle()) return;
      try {
        this.roomBlocks();
        this.memory.applyRequests();
      } catch (error) {
        warn(`cc ${bot}: ${(error as Error).message}`);
      }
    }, 1000);
    (this.scan as { unref?: () => void }).unref?.();
    this.pumpTimer = setInterval(() => void this.pump(), opts.tickMs ?? 500);
    (this.pumpTimer as { unref?: () => void }).unref?.();
  }

  /** Takes the profile lock (a busy profile rejects with pi-optchat's ProfileBusyError) and loads its memory. */
  static async open(bot: string, dir: string, opts: CcEngineOptions = {}): Promise<CcEngine> {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const unlock = await lockProfile(dir, `DinoBot Claude Code bot ${bot} (pid ${process.pid})`);
    try {
      return new CcEngine(bot, dir, unlock, opts);
    } catch (error) {
      await unlock();
      throw error;
    }
  }

  onEvent(listener: (e: CcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(e: CcEvent) {
    for (const l of this.listeners) l(e);
  }
  /** The daemon log, and the bot's chat (a notification row, as pi-optchat's warnings). */
  private warn(text: string) {
    this.opts.warn?.(text);
    this.emit({ type: "warning", text });
  }

  setEnv(env: NodeJS.ProcessEnv) {
    this.opts.env = env;
  }

  /**
   * The model and effort the TUI runs on, from the chat (the app's picker): the inbox mod's turn.step hook asks /run
   * at each main-loop step, so a switch applies from the next step, with no restart (unset: the TUI's own).
   */
  private run: { model?: string; effort?: string } = {};
  setRun(run: { model?: string; effort?: string }) {
    this.run = { ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) };
  }

  /** The TUI to type into (the provider sets it once it knows the bot's herdr agent). */
  setDelivery(delivery: CcDelivery | undefined) {
    this.opts.delivery = delivery;
  }

  private loadSettings() {
    try {
      this.settings = readSettings(JSON.parse(readFileSync(join(this.dir, "config.json"), "utf8")));
    } catch {
      this.settings = readSettings({});
    }
  }

  // ------------------------------------------------------------------ prompts

  /**
   * The turn's system prompt, as pi-optchat composes it for a bot: OptChat's rules, the skills (as pi lists them:
   * skills.ts), the host section, AGENTS.md (the profile's, last: it changes most often).
   */
  systemPrompt(): string {
    this.loadSettings();
    const env = this.opts.env ?? process.env;
    let agents = "";
    try {
      agents = readFileSync(join(this.dir, "AGENTS.md"), "utf8").trim();
    } catch {}
    const skills = formatCcSkills(
      ccBotSkills({
        pluginSkillsDir: this.opts.skillsDir,
        botDir: this.opts.botDir,
        profileDir: this.dir,
        optchatHome: dirname(dirname(this.dir)),
        piAgentDir: env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME || homedir(), ".pi", "agent"),
        home: env.HOME || homedir(),
      }),
    );
    const parts = [sharedPrompt(this.settings.previousExchange, env, false), skills, botSection(env), agents];
    if (this.memory.hasImported()) parts.push(IMPORT_GUIDANCE);
    return parts.filter(Boolean).join("\n\n");
  }

  // ------------------------------------------------------------------ compaction jobs

  private hostRunner(): CompactorRunner | null {
    if (this.opts.hostRunner) return this.opts.hostRunner();
    try {
      return readBotsSettings(process.env).compactorRunner;
    } catch {
      return null;
    }
  }

  private plan(): CompactorPlan {
    const plan = compactorPlan(this.dir, this.hostRunner());
    this.lastPlan = plan;
    // A non-Claude model kept in-session by the bot's own setting runs as a Claude family: say so once, not silently.
    const key = `${plan.runner}:${plan.pi.provider}/${plan.pi.model}:${plan.inSession.model}`;
    if (plan.runner === "in-session" && plan.why === "bot" && !(plan.pi.provider === "anthropic" && /^claude-/.test(plan.pi.model)) && this.warnedPlan !== key) {
      this.warnedPlan = key;
      this.warn(
        `cc ${this.bot}: compactor ${plan.pi.provider}/${plan.pi.model} runs in-session as ${plan.inSession.model} (compactorRunner "in-session"; set "pi" or remove it to use that model)`,
      );
    }
    return plan;
  }

  /** One summary attempt on the planned runner; pi's failure falls back to the TUI (logged) and rests pi a while. */
  private async attempt(plan: CompactorPlan, system: string, prompt: CcJob["prompt"], signal: AbortSignal): Promise<CcJobResult> {
    const inSession = (fallbackFrom?: CompactorRunner) =>
      this.runJob(
        { id: randomUUID(), model: plan.inSession.model, ...(plan.inSession.effort ? { effort: plan.inSession.effort } : {}), maxTokens: 16_000, system, prompt },
        signal,
        fallbackFrom,
      );
    if (plan.runner !== "pi") return inSession();
    if (Date.now() < this.piRestUntil) return inSession("pi");
    const model = `${plan.pi.provider}/${plan.pi.model}`;
    let error: string;
    try {
      const r = await this.pi({ ...plan.pi, system, prompt: prompt.map((b) => b.text).join("\n\n"), cwd: this.dir }, signal);
      if ("text" in r) {
        this.logUsage({ runner: "pi", model: r.model || model, usage: r.usage ?? null });
        // pi-run summaries count in the chat's cost too (CU1): pi's own usage, priced by pi.
        const u = (r.usage && typeof r.usage === "object" ? r.usage : {}) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
        const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
        const total = u.cost?.total;
        this.countCompaction(
          { input_tokens: num(u.input), output_tokens: num(u.output), cache_read_input_tokens: num(u.cacheRead), cache_creation_input_tokens: num(u.cacheWrite) },
          typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null,
          model,
        );
        return { text: r.text };
      }
      error = r.error + (r.status ? ` (status ${r.status})` : "");
    } catch (e) {
      if (signal.aborted) throw e;
      error = String((e as Error)?.message ?? e);
    }
    const rest = this.opts.piRestMs ?? PI_REST_MS;
    this.piRestUntil = Date.now() + rest;
    this.warn(`cc ${this.bot}: pi compactor failed (${model}): ${error.slice(0, 300)}; running in-session for ${Math.round(rest / 60_000)} min`);
    this.appendLog("compactor-runner.jsonl", { t: new Date().toISOString(), runner: "pi", model, fallback: "in-session", restMs: rest, error: error.slice(0, 2000) });
    return inSession("pi");
  }

  private appendLog(file: string, line: unknown) {
    try {
      appendFileSync(join(this.dir, file), JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {}
  }
  /** What each compaction cost, per runner (in-session: Claude Code's report, plan usage; pi: pi's usage with $ cost). */
  private logUsage(entry: { runner: CompactorRunner; model: unknown; usage: unknown; costUsd?: number | null; pricedAs?: string | null; fallbackFrom?: CompactorRunner }) {
    this.appendLog("compactor-usage.jsonl", { t: new Date().toISOString(), ...entry });
  }

  private async compress(input: Compression, signal: AbortSignal): Promise<string> {
    const plan = this.plan();
    const { blocks, whole } = viewBlocks(input.context);
    const view = blocks.map((text, j) => ({ text, ...(j === whole - 1 ? { cache: true } : {}) })).filter((b) => b.text.trim());
    const system = compactorPrompt(this.opts.env ?? process.env);
    const accepted = Math.max(NODE, this.settings.summaryAcceptBytes ?? NODE);
    const tries: string[] = [];
    let extra = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.attempt(plan, system, [...view, { text: task(input) + extra }], signal);
      if ("error" in r) throw new CompactorError(`Compactor (Claude Code): ${r.error}`, r.status, r.retryAfterMs);
      const line = r.text.trim().replace(/^\d+\+\d+\|\s*/, "");
      if (!line) throw new Error("Compactor returned no text.");
      tries.push(line);
      if (bytes(line) <= accepted && bytes(line) < bytes(input.source)) break;
      // $.model.complete takes one user message: the retry quotes the long line in the task instead of a second turn.
      const cut = Buffer.from(line).subarray(0, NODE).toString("utf8").replace(/\uFFFD$/, "");
      extra = `\n\nYour line was:\n${line}\nToo long: it is ${bytes(line)} bytes, over the ${NODE}-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\n${cut}| ← LIMIT`;
    }
    return tries.reduce((a, b) => (bytes(a) <= bytes(b) ? a : b));
  }

  private runJob(job: CcJob, signal: AbortSignal, fallbackFrom?: CompactorRunner): Promise<CcJobResult> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.jobs.delete(job.id);
        reject((signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted"));
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.jobs.set(job.id, {
        job,
        takenAt: 0,
        ...(fallbackFrom ? { fallbackFrom } : {}),
        done: (r) => {
          signal.removeEventListener("abort", abort);
          this.jobs.delete(job.id);
          resolve(r);
        },
      });
    });
  }

  /** Jobs for the TUI: new ones, and ones a TUI took but never answered (it restarted). */
  takeJobs(max = 4): CcJob[] {
    const now = Date.now();
    const out: CcJob[] = [];
    for (const j of this.jobs.values()) {
      if (out.length >= max) break;
      if (j.takenAt && now - j.takenAt < JOB_LEASE_MS) continue;
      j.takenAt = now;
      out.push(j.job);
    }
    return out;
  }

  finishJob(id: string, result: CcJobResult): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    j.done(result);
    return true;
  }

  get pendingJobs() {
    return this.jobs.size;
  }

  /**
   * A compaction's cost for the chat's total (server/cc/usage.ts): Claude Code leaves `$.model.complete` out of its
   * own cost, so it is added on top, priced from pi's catalog unless the runner gave its price (`costUsd`, e.g. a pi
   * runner's `usage.cost.total`). `family` is Claude Code's alias the job ran on.
   */
  countCompaction(tokens: CcTokens, costUsd: number | null, family: string | null): { costUsd: number | null; pricedAs: string | null } {
    const priced = costUsd === null ? anthropicPrice(compactorModelId(this.dir), family ?? compactorModel(this.dir).model, this.opts.env ?? process.env) : null;
    const cost = costUsd ?? (priced ? priceOf(tokens, priced.price) : null);
    this.emit({ type: "extra-usage", tokens, costUsd: cost, model: priced?.id ?? family });
    return { costUsd: cost, pricedAs: priced?.id ?? null };
  }

  // ------------------------------------------------------------------ inbox (pi-optchat's pending-inputs.json)

  private get inboxFile() {
    return join(this.dir, "pending-inputs.json");
  }
  private loadInbox() {
    try {
      const saved = JSON.parse(readFileSync(this.inboxFile, "utf8"));
      if (Array.isArray(saved)) this.items = saved.filter((i) => i && typeof i.id === "string" && typeof i.text === "string" && !this.receipts.has(i.id));
    } catch {}
    // One in its turn (the TUI goes on through a daemon restart) stays submitted: that turn's log receipts it, and it
    // is never typed again. One being typed goes again (unless the transcript shows it: deliverStep).
    for (const i of this.items) if (i.state !== "submitted") i.state = "queued";
  }

  /**
   * A new TUI: the messages whose turn died with the old one go into memory as unanswered (pi-optchat's
   * Inbox.recover), so the bot sees them and they are not answered twice; one typed and not seen goes again.
   */
  private recoverInbox() {
    for (const i of this.items) {
      if (i.state !== "submitted") {
        i.state = "queued";
        continue;
      }
      if (!this.receipts.has(i.id)) this.memory.append("user", i.text, i.date, i.id);
      this.receipts.add(i.id);
      this.deliveryLog({ ev: "recovered", id: i.id });
    }
    this.items = this.items.filter((i) => i.state !== "submitted");
    this.saveInbox();
  }
  private saveInbox() {
    const tmp = `${this.inboxFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 });
    renameSync(tmp, this.inboxFile);
  }

  /**
   * A message for the bot (the app, bot-dm, a room). The same id twice is delivered once. It is kept as it will be
   * typed (deliver.ts typedText: normalised, a leading `/` or `!` guarded), so the logged message matches it.
   */
  enqueue(text: string, id: string = randomUUID()): string {
    if (this.receipts.has(id) || this.items.some((i) => i.id === id)) return id;
    const typed = typedText(text, id, join(this.dir, "inbox-long"));
    if (!typed.trim()) return id;
    this.items.push({ id, text: typed, date: new Date().toISOString(), state: "queued", typed: 0 });
    this.saveInbox();
    this.deliveryLog({ ev: "queued", id, bytes: Buffer.byteLength(typed) });
    void this.pump();
    return id;
  }

  /** Drops a message still waiting (not yet typed into the TUI). */
  cancel(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id || i.state === "submitted" || i.state === "delivering");
    if (this.items.length === before) return false;
    this.saveInbox();
    this.deliveryLog({ ev: "canceled", id });
    return true;
  }

  /** An item's text while it is in the inbox (queued, being typed, or in its turn and not yet logged). */
  itemText(id: string): string | undefined {
    return this.items.find((i) => i.id === id)?.text;
  }

  // ------------------------------------------------------------------ delivery (typed with herdr: deliver.ts)

  /** One line per delivery step in the profile's cc-delivery.jsonl. */
  private deliveryLog(o: Record<string, unknown>) {
    try {
      appendFileSync(join(this.dir, "cc-delivery.jsonl"), JSON.stringify({ t: new Date().toISOString(), bot: this.bot, ...o }) + "\n", { mode: 0o600 });
    } catch {}
  }

  private backoff(now = Date.now()) {
    this.failures++;
    this.retryAt = now + Math.min(BACKOFF_MAX_MS, 1000 * 2 ** (this.failures - 1));
  }

  /** The typed item was seen (the hook, or the transcript): it runs as the turn it started. */
  private acked(item: InboxItem, how: string) {
    if (item.state !== "delivering") return;
    item.state = "submitted";
    const f = this.inflight;
    this.inflight = null;
    this.failures = 0;
    this.retryAt = 0;
    Object.assign(this.turn, { running: true, since: Date.now() });
    this.saveInbox();
    this.deliveryLog({ ev: "acked", id: item.id, how, ms: f ? Date.now() - f.typedAt : null, typed: item.typed });
    this.emit({ type: "started", id: item.id, text: item.text });
  }

  /**
   * The typed item went into a turn that was running (a turn of the TUI's own started between the idle check and the
   * Enter): Claude Code answers it in that turn, but the turn's compaction does not carry it, so it is logged here.
   */
  private merged(item: InboxItem, how: string) {
    if (item.state !== "delivering") return;
    if (this.inflight?.item === item) this.inflight = null;
    this.failures = 0;
    this.retryAt = 0;
    this.memory.append("user", item.text, undefined, item.id);
    this.receipts.add(item.id);
    this.items = this.items.filter((i) => i !== item);
    this.saveInbox();
    this.deliveryLog({ ev: "merged", id: item.id, how, typed: item.typed });
    this.emit({ type: "merged", id: item.id });
  }

  /** Types the next item, or follows up the one typed. One at a time; the engine's own timer calls it. */
  async pump(): Promise<void> {
    if (this.pumping || this.closed || !this.opts.delivery) return;
    this.pumping = true;
    try {
      await this.deliverStep(this.opts.delivery);
    } catch (error) {
      this.warn(`cc ${this.bot}: delivery: ${(error as Error).message}`);
    } finally {
      this.pumping = false;
    }
  }

  private async deliverStep(d: CcDelivery) {
    const now = Date.now();
    const f = this.inflight;
    if (f) {
      if (f.item.state !== "delivering" || !this.items.includes(f.item)) {
        this.inflight = null;
        return;
      }
      if (now < f.deadline) return;
      // No ack in time. Never type blindly: first the transcript (the hook's post may have been lost).
      const file = await d.sessionFile().catch(() => null);
      const seen = file ? transcriptHas(file, f.item.text, f.typedAt) : null;
      if (seen === "queued") return this.merged(f.item, "transcript");
      if (seen) return this.acked(f.item, "transcript");
      const st = await d.state().catch(() => "unknown");
      if (st === "working" || st === "blocked") {
        // A turn runs (ours with a lost ack, or another): look again when it is over.
        if (now - f.typedAt < BUSY_TURN_MS) {
          f.deadline = now + (this.opts.ackMs ?? ACK_MS);
          return;
        }
      }
      this.inflight = null;
      if (st === "gone") {
        // The TUI is gone: its next start says /hello and the item goes again.
        f.item.state = "queued";
        this.deliveryLog({ ev: "no-ack", id: f.item.id, state: st });
        return;
      }
      if ((f.item.typed ?? 0) >= (this.opts.maxTyped ?? MAX_TYPED)) {
        this.items = this.items.filter((i) => i !== f.item);
        this.saveInbox();
        const reason = `typed ${f.item.typed} times into the bot's Claude Code and never seen`;
        this.deliveryLog({ ev: "undelivered", id: f.item.id, reason });
        this.emit({ type: "undelivered", id: f.item.id, reason });
        return;
      }
      // Whatever is left in the composer goes before the text is typed again.
      await d.clear(f.item.text).catch(() => {});
      f.item.state = "queued";
      this.deliveryLog({ ev: "no-ack", id: f.item.id, state: st, retype: true });
      this.backoff(now);
      return;
    }

    if (!this.idle(now) || now < this.retryAt) return;
    const item = this.items.find((i) => i.state === "queued");
    if (!item) return;
    const st = await d.state().catch(() => "unknown");
    if (st !== "idle" && st !== "done") {
      // working: a turn of the TUI's own (typed there, a task notification) the hooks have not reported yet;
      // blocked: a permission prompt or a question waits in the terminal. Never type into either.
      if (st === "blocked" && !this.blockedSince) {
        this.blockedSince = now;
        this.emit({ type: "blocked", since: now });
      }
      if (this.lastWait !== st) this.deliveryLog({ ev: "wait", id: item.id, state: st });
      this.lastWait = st;
      // Polled, not backed off: the item goes as soon as the TUI is free.
      this.retryAt = now + (st === "blocked" ? 2000 : 1000);
      return;
    }
    this.blockedSince = 0;
    this.lastWait = "";
    // A turn may have started while herdr was asked; a canceled item is gone.
    if (!this.idle() || item.state !== "queued" || !this.items.includes(item)) return;
    item.state = "delivering";
    const typedAt = Date.now();
    // In flight before typing: the hook's ack can come back before herdr returns.
    this.inflight = { item, typedAt, deadline: typedAt + (this.opts.ackMs ?? ACK_MS) };
    const r = await d.prompt(item.text).catch((error: Error) => ({ ok: false as const, code: "error", message: error.message }));
    if (!r.ok) {
      // Nothing was typed (herdr refuses before it types: agent_blocked, agent_not_ready, not found).
      if (this.inflight?.item === item) this.inflight = null;
      if (item.state === "delivering") item.state = "queued";
      this.deliveryLog({ ev: "refused", id: item.id, code: r.code, message: r.message });
      this.backoff();
      return;
    }
    item.typed = (item.typed ?? 0) + 1;
    this.deliveryLog({ ev: "typed", id: item.id, n: item.typed, ms: Date.now() - typedAt });
  }

  get queued() {
    return this.items.length;
  }

  idle(now = Date.now()) {
    if (this.turn.running && now - this.turn.since > BUSY_TURN_MS) this.turn.running = false;
    if (this.turn.compactDue && now - this.turn.endedAt > COMPACT_DUE_MS) this.turn.compactDue = false;
    return !this.turn.running && !this.turn.compactDue;
  }
  get running() {
    return this.turn.running;
  }

  private roomBlocks() {
    const before = this.memory.root.length;
    applyRoomBlocks(this.memory, this.dir, (s) => this.warn(s));
    for (const e of this.memory.root.slice(before)) if (e.receipt) this.receipts.add(e.receipt);
  }

  // ------------------------------------------------------------------ the mods' calls

  async handle(method: string, path: string, query: URLSearchParams, body: any): Promise<{ status: number; json: unknown }> {
    const ok = (json: unknown) => ({ status: 200, json });
    switch (`${method} ${path}`) {
      case "GET /run":
        return ok(this.run);
      case "GET /prompt":
        return ok({ text: this.systemPrompt() });
      case "POST /hello": {
        // A (re)started TUI: what the old one had typed goes again, what its turn died with is logged; its unanswered jobs go again.
        this.recoverInbox();
        this.inflight = null;
        this.retryAt = 0;
        this.failures = 0;
        for (const j of this.jobs.values()) j.takenAt = 0;
        Object.assign(this.turn, { running: false, compactDue: false });
        this.emit({ type: "session", restarted: true });
        return ok({ inbox: this.items.length });
      }
      // An inbox mod from before typed delivery (a TUI not yet started again): it gets nothing to submit, so no
      // message goes twice.
      case "GET /inbox/next":
        return ok({ item: null });
      case "POST /inbox/submitted":
      case "POST /inbox/requeue":
        return ok({ ok: false });
      case "POST /turn": {
        const now = Date.now();
        if (body.running) {
          const wasRunning = this.idle(now) ? false : this.turn.running;
          // Into the running turn: Claude Code says so (the inbox mod's `into`, from the submit's turnId); an older
          // mod does not, and the engine's own running turn stands in.
          const into = typeof body.into === "boolean" ? body.into : wasRunning;
          Object.assign(this.turn, { running: true, since: wasRunning ? this.turn.since : now });
          // The item the engine typed: its ack. Anything else the TUI submitted itself (typed in the terminal, or
          // Claude Code's own like a background task's notification) starts a turn of its own, unless it went into
          // the running turn: then that turn's one turn.complete ends it, so it starts none.
          const f = this.inflight;
          const origin = typeof body.origin === "string" && body.origin ? { origin: body.origin } : {};
          if (body.typed && f && f.item.state === "delivering" && body.origin !== "task-notification" && sameText(String(body.text ?? ""), f.item.text))
            // Into a turn already running (one of the TUI's own started just before the Enter): merged into it.
            into ? this.merged(f.item, "hook") : this.acked(f.item, "hook");
          else if (body.typed && into) this.emit({ type: "into", text: String(body.text ?? ""), ...origin });
          else if (body.typed) this.emit({ type: "started", id: null, text: String(body.text ?? ""), ...origin });
        } else {
          // Every turn ends with the trigger mod's compaction (stopped and failed ones too): the inbox waits for it.
          Object.assign(this.turn, { running: false, endedAt: now, compactDue: true });
          const detail = typeof body.refusal?.explanation === "string" ? body.refusal.explanation : typeof body.error === "string" ? body.error : "";
          this.emit({
            type: "complete",
            aborted: !body.answered,
            reason: typeof body.reason === "string" ? body.reason : null,
            ...(detail.trim() ? { detail: detail.trim().slice(0, 1000) } : {}),
          });
        }
        return ok({ ok: true });
      }
      case "POST /event": {
        if (body.type === "step") this.emit({ type: "step", answer: String(body.answer ?? ""), ...(body.partial === true ? { partial: true } : {}) });
        else if (body.type === "thinking") {
          const text = String(body.text ?? "");
          if (text.trim()) this.emit({ type: "thinking", block: String(body.block ?? ""), text: text.slice(0, 64_000) });
        }        else if (body.type === "tool")
          this.emit({
            type: "tool",
            phase: body.phase === "done" ? "done" : "running",
            id: String(body.id ?? ""),
            name: String(body.name ?? ""),
            input: body.input ?? null,
            ...(body.phase === "done" ? { output: String(body.output ?? ""), isError: body.isError === true, ...images(body.images) } : {}),
          });
        return ok({ ok: true });
      }
      case "POST /append": {
        const ids: number[] = [];
        this.loadSettings();
        // The profile's Tool digest: the turn's calls, results and commentary go through pi-optchat's RunLog as one entry.
        const digest = this.settings.toolDigest ? new RunLog(this.memory, true) : null;
        const messages = ((body.messages ?? []) as AppendEntry[]).filter((m) => typeof m?.text === "string" && m.text.trim());
        for (let k = 0; k < messages.length; k++) {
          const m = messages[k]!;
          // A user message that is an inbox item carries its id as the receipt, then leaves the journal.
          const item = m.kind === "user" ? this.items.find((i) => i.state === "submitted" && i.text.trim() === m.text.trim()) : undefined;
          if (digest) {
            const before = this.memory.root.length;
            k = digestWrite(digest, this.memory, messages, k, item?.id);
            if (k === messages.length - 1) digest.end();
            for (let i = before; i < this.memory.root.length; i++) ids.push(i);
          } else ids.push(this.memory.append(m.kind, m.kind === "echo" ? cap(m.text) : m.text, undefined, item?.id).i);
          if (item) {
            this.receipts.add(item.id);
            this.items = this.items.filter((i) => i !== item);
            this.saveInbox();
          }
        }
        this.turn.compactDue = false;
        this.roomBlocks();
        this.checkpoint();
        return ok({ ids, total: this.memory.root.length });
      }
      case "GET /view": {
        if (query.has("settle")) {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), Math.min(Number(query.get("settle")) || 20_000, 60_000));
          try {
            await this.memory.settle(ac.signal);
          } catch {
            return { status: 202, json: { settled: false, pending: this.memory.pending } };
          } finally {
            clearTimeout(t);
          }
        }
        this.loadSettings();
        return ok({
          settled: true,
          view: this.memory.render(),
          bytes: this.memory.size,
          total: this.memory.root.length,
          previousExchange: this.settings.previousExchange,
          previousExchangeBytes: this.settings.previousExchangeKB * 1000,
        });
      }
      case "GET /jobs":
        return ok({ jobs: this.takeJobs(Math.max(1, Math.min(8, Number(query.get("max")) || 4))) });
      case "POST /job": {
        const r: CcJobResult =
          typeof body.text === "string"
            ? { text: body.text }
            : { error: String(body.error ?? "no reply"), ...(typeof body.status === "number" ? { status: body.status } : {}), ...(typeof body.retryAfterMs === "number" ? { retryAfterMs: body.retryAfterMs } : {}) };
        // What each compaction cost, as Claude Code reported it (plan usage; cache reads show the shared prefix).
        if (body.usage && typeof body.usage === "object") {
          const from = this.jobs.get(String(body.id ?? ""))?.fallbackFrom;
          const given = typeof body.costUsd === "number" && Number.isFinite(body.costUsd) && body.costUsd >= 0 ? (body.costUsd as number) : null;
          const priced = this.countCompaction(body.usage, given, typeof body.model === "string" ? body.model : null);
          this.logUsage({ runner: "in-session", model: body.model ?? null, usage: body.usage, ...priced, ...(from ? { fallbackFrom: from } : {}) });
        }
        return ok({ ok: this.finishJob(String(body.id ?? ""), r) });
      }
      case "POST /usage": {
        const usage = runUsage(body);
        if (usage) this.emit({ type: "usage", usage });
        return ok({ ok: !!usage });
      }
      case "POST /tool": {
        const a = body.arguments ?? {};
        try {
          const text =
            body.name === "zoom"
              ? this.memory.zoom(Number(a.id), Number(a.n))
              : body.name === "date"
                ? this.memory.date(Number(a.id))
                : body.name === "search_memory"
                  ? this.memory.search(String(a.query), a.limit === undefined ? undefined : Number(a.limit))
                  : null;
          return ok(text === null ? { isError: true, text: `unknown tool ${body.name}` } : { text });
        } catch (error) {
          return ok({ isError: true, text: (error as Error).message });
        }
      }
      case "GET /status":
        return ok({
          total: this.memory.root.length,
          pending: this.memory.pending,
          jobs: this.jobs.size,
          inbox: this.items.length,
          turn: this.turn,
          compactor: this.compactorStatus(),
          delivering: this.inflight ? { id: this.inflight.item.id, typedAt: this.inflight.typedAt } : null,
          retryAt: this.retryAt,
        });
    }
    return { status: 404, json: { error: "no route" } };
  }

  /** A git commit of the profile after each turn's log, as pi-optchat makes after each run; not waited for. */
  private checkpoint() {
    this.checkpoints = this.checkpoints.then(() => checkpoint(this.dir)).catch((error) => this.warn(`cc ${this.bot}: local checkpoint failed: ${(error as Error).message}`));
  }

  /** Where summaries run now: the runner, why, the model; while pi rests after a failure, until when. */
  compactorStatus() {
    const plan = this.lastPlan ?? compactorPlan(this.dir, this.hostRunner());
    return {
      runner: plan.runner,
      why: plan.why,
      model: plan.runner === "pi" ? `${plan.pi.provider}/${plan.pi.model}` : plan.inSession.model,
      ...(this.piRestUntil > Date.now() ? { piRestingUntil: new Date(this.piRestUntil).toISOString() } : {}),
    };
  }

  /** The newest log entries (messages, tool calls and their results), for the app's history of a reopened chat. */
  recent(limit = 400): Array<{ i: number; kind: Kind; text: string; date: string }> {
    return this.memory.root
      .filter((e) => e.kind === "user" || e.kind === "talk" || e.kind === "tool" || e.kind === "echo")
      .slice(-limit)
      .map((e) => ({ i: e.i, kind: e.kind, text: e.text, date: e.date }));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.scan);
    clearInterval(this.pumpTimer);
    for (const j of [...this.jobs.values()]) j.done({ error: "engine closed", status: 503 });
    await this.memory.close().catch(() => {});
    this.checkpoint();
    await this.checkpoints;
    await this.unlock().catch(() => {});
  }
}

/**
 * The engines' loopback HTTP server: `/b/<bot>/<route>` with `authorization: Bearer <the bot's token>`. Each bot's
 * `{url, token}` goes to `<stateDir>/<bot>/engine.json` (0600), which its mods read; a new daemon (new port) rewrites it.
 */
export class CcHost {
  private server: Server | null = null;
  private port = 0;
  readonly engines = new Map<string, CcEngine>();

  constructor(readonly stateDir: string) {}

  private async listen(): Promise<number> {
    if (this.server) return this.port;
    const server = createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    return this.port;
  }

  botDir(bot: string) {
    return join(this.stateDir, bot);
  }

  /** The bot's engine, opened (lock taken) on first use; engine.json written for its mods. */
  async engine(bot: string, profileDir: string, opts: CcEngineOptions = {}): Promise<CcEngine> {
    let engine = this.engines.get(bot);
    if (engine) {
      if (opts.env) engine.setEnv(opts.env);
      return engine;
    }
    const port = await this.listen();
    engine = await CcEngine.open(bot, profileDir, opts);
    this.engines.set(bot, engine);
    const dir = this.botDir(bot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "engine.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ url: `http://127.0.0.1:${port}/b/${bot}`, token: engine.token }) + "\n", { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
    return engine;
  }

  private async serve(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const m = /^\/b\/([^/]+)(\/.*)$/.exec(url.pathname);
      const engine = m ? this.engines.get(decodeURIComponent(m[1]!)) : undefined;
      if (!m || !engine) return send(404, { error: "no such bot" });
      const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
      const want = Buffer.from(engine.token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return send(401, { error: "bad token" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 32 * 1024 * 1024) return send(413, { error: "too large" });
      }
      const r = await engine.handle(req.method ?? "GET", m[2]!, url.searchParams, raw ? JSON.parse(raw) : {});
      send(r.status, r.json);
    } catch (error) {
      send(500, { error: String((error as Error).message ?? error) });
    }
  }

  async close(bot?: string) {
    const bots = bot ? [bot] : [...this.engines.keys()];
    for (const b of bots) {
      await this.engines.get(b)?.close();
      this.engines.delete(b);
    }
    if (!bot) {
      this.server?.close();
      this.server = null;
    }
  }
}

/** A log entry from the view mod; a call (tool) and its result (echo) carry the call's id, name, input and result. */
interface AppendEntry {
  kind: Kind;
  text: string;
  name?: string;
  input?: unknown;
  call?: string;
  result?: string;
  isError?: boolean;
}

/**
 * Writes `messages[k]` to pi-optchat's RunLog as the pi message it stands for (a talk with the calls after it is one
 * assistant message); returns the index of the last entry taken. An echo with no call (a background task's notice) is
 * logged as it is.
 */
function digestWrite(log: RunLog, memory: Memory, messages: AppendEntry[], k: number, receipt?: string): number {
  const m = messages[k]!;
  const timestamp = Date.now();
  const assistant = (content: unknown[]) => ({ role: "assistant", content, stopReason: content.some((c: any) => c.type === "toolCall") ? "toolUse" : "stop", timestamp }) as never;
  const call = (e: AppendEntry) => ({ type: "toolCall", id: e.call, name: e.name, arguments: e.input ?? {} });
  const isCall = (e: AppendEntry | undefined) => e?.kind === "tool" && typeof e.call === "string";
  if (m.kind === "user") log.write({ role: "user", content: m.text, timestamp } as never, receipt);
  else if (m.kind === "talk" || isCall(m)) {
    const content: unknown[] = m.kind === "talk" ? [{ type: "text", text: m.text }] : [call(m)];
    while (isCall(messages[k + 1])) content.push(call(messages[++k]!));
    log.write(assistant(content));
  } else if (m.kind === "echo" && typeof m.call === "string")
    log.write({ role: "toolResult", toolCallId: m.call, toolName: m.name ?? "", content: [{ type: "text", text: m.result ?? m.text }], isError: m.isError === true, timestamp } as never);
  else {
    log.end();
    memory.append(m.kind, m.kind === "echo" ? cap(m.text) : m.text);
  }
  return k;
}

/** True when a profile already has a log (for "has history" checks without opening it). */
export function hasMemory(dir: string) {
  return existsSync(join(dir, "main")) && readdirSync(join(dir, "main")).some((f) => f.endsWith(".jsonl"));
}
