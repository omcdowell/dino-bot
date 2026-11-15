/**
 * Context, cost and token figures of a Claude Code bot, for the app's context meter (Paseo `session.usage`).
 *
 * The bot's TUI (the inbox mod) reports Claude Code's own figures (`$.session.usage()` / `session.measure`): the
 * context window and its fill, the session's cost as /cost totals it, the rate-limit windows, and the tokens of its
 * turns. Claude Code's figures start at 0 in every TUI process (a relaunch on a new model, a crash, a daemon
 * restart), so each process is a "run" and the ledger adds what each run grew by to the chat (the Paseo session)
 * that showed it, as pi's session stats do for a pi bot's chat.
 *
 * Compactions run in the TUI with `$.model.complete`, which Claude Code leaves out of its cost (proven: a 100k-token
 * `$.model.complete` left `$.session.usage().cost` at 0; the next turn of the same size cost $0.0105). The engine
 * prices each one from pi's model catalog (`compactorCost`) and the ledger adds it on top: no double counting.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderUsage } from "@getpaseo/plugin/server/provider";

/** Token counts as Claude Code reports them (ModelUsage). */
export interface CcTokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** What the inbox mod posts to the engine's `/usage`: one TUI process's figures so far. */
export interface CcRunUsage {
  /** This TUI process (Claude Code session id and start time): its figures start at 0. */
  run: string;
  /** The context window and its fill (`tokens`: the last response's input side; `estimate`: a local count). */
  context?: { window?: number; tokens?: number; estimate?: number };
  /** Claude Code's session cost so far, in US$ (its /cost; without `$.model.complete` calls). */
  costUsd?: number;
  /** The tokens of this process's turns so far, summed. */
  tokens?: CcTokens;
  rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }>;
}

/** What a run or a compaction adds. */
interface Totals {
  usd: number;
  input: number;
  cached: number;
  output: number;
}
const ZERO: Totals = { usd: 0, input: 0, cached: 0, output: 0 };

interface LedgerFile {
  v: 1;
  /** Each TUI process's figures as last seen (newest last). */
  runs: Record<string, Totals>;
  /** Each chat's sums and last context. */
  sessions: Record<string, Totals & { window?: number; used?: number }>;
  rateLimits?: CcRunUsage["rateLimits"];
  /** When Claude Code last reported `rateLimits` (ISO): the usage card says how old its windows are. */
  rateLimitsAt?: string;
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
const MAX_RUNS = 50;
const MAX_SESSIONS = 50;

/** Input tokens as Paseo counts them for pi (uncached input plus cache writes; cache reads apart). */
export function totalsOf(t: CcTokens | undefined, usd = 0): Totals {
  return {
    usd: num(usd),
    input: num(t?.input_tokens) + num(t?.cache_creation_input_tokens),
    cached: num(t?.cache_read_input_tokens),
    output: num(t?.output_tokens),
  };
}

/** One bot's usage ledger (`<bot state dir>/usage.json`). */
export class CcUsageLedger {
  private data: LedgerFile;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.data = { v: 1, runs: {}, sessions: {} };
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      if (d && d.v === 1 && typeof d.runs === "object" && typeof d.sessions === "object") this.data = d;
    } catch {}
  }

  /** A run's figures so far: what it grew by since last seen goes to `session`. Returns the session's usage. */
  run(session: string, r: CcRunUsage): ProviderUsage {
    const now = totalsOf(r.tokens, r.costUsd);
    const seen = this.data.runs[r.run];
    // An unknown run starts from 0; figures never go down (a stale report adds nothing).
    const was = seen ?? ZERO;
    const s = this.session(session);
    const next: Totals = { ...was };
    for (const k of ["usd", "input", "cached", "output"] as const) {
      if (now[k] > was[k]) {
        s[k] += now[k] - was[k];
        next[k] = now[k];
      }
    }
    delete this.data.runs[r.run];
    this.data.runs[r.run] = next;
    const runs = Object.keys(this.data.runs);
    for (const k of runs.slice(0, Math.max(0, runs.length - MAX_RUNS))) delete this.data.runs[k];
    const window = num(r.context?.window);
    if (window) s.window = window;
    const used = r.context?.tokens ?? r.context?.estimate;
    if (typeof used === "number" && Number.isFinite(used) && used >= 0) s.used = used;
    if (Array.isArray(r.rateLimits) && r.rateLimits.length) {
      this.data.rateLimits = r.rateLimits;
      this.data.rateLimitsAt = new Date(this.now()).toISOString();
    }
    this.save();
    return this.usage(session)!;
  }

  /** A cost Claude Code does not count (a compaction): added to `session`. */
  extra(session: string, t: CcTokens | undefined, usd: number): ProviderUsage {
    const s = this.session(session);
    const add = totalsOf(t, usd);
    for (const k of ["usd", "input", "cached", "output"] as const) s[k] += add[k];
    this.save();
    return this.usage(session)!;
  }

  /** The chat's figures for Paseo, or null when nothing was counted for it. */
  usage(session: string): ProviderUsage | null {
    const s = this.data.sessions[session];
    if (!s) return null;
    return {
      inputTokens: s.input,
      cachedInputTokens: s.cached,
      outputTokens: s.output,
      totalCostUsd: Math.round(s.usd * 1e6) / 1e6,
      ...(s.window ? { contextWindowMaxTokens: s.window } : {}),
      ...(s.window && typeof s.used === "number" ? { contextWindowUsedTokens: s.used } : {}),
    };
  }

  get rateLimits() {
    return this.data.rateLimits ?? [];
  }

  private session(id: string) {
    let s = this.data.sessions[id];
    if (!s) {
      s = this.data.sessions[id] = { ...ZERO };
      const ids = Object.keys(this.data.sessions);
      for (const k of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) if (k !== id) delete this.data.sessions[k];
    }
    return s;
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {}
  }
}

// ------------------------------------------------------------------ compaction prices

/** US$ per million tokens, as pi's model catalog has them (`tiers`: dearer above an input size). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
}

/** pi's folder: PI_CODING_AGENT_DIR (DinoBot's daemon sets it), else ~/.pi/agent. */
export const piAgentDir = (env: NodeJS.ProcessEnv = process.env) => env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/**
 * Anthropic prices from pi's catalog (`models-store.json`, the one pi prices its own calls with; its figures match
 * Claude Code's: haiku-5-5 100k in + 1k out = $0.0105 in both). `family` (opus, sonnet, haiku: Claude Code's alias)
 * with no exact `model` picks that family's newest.
 */
export function anthropicPrice(model: string | undefined, family: string | undefined, env: NodeJS.ProcessEnv = process.env): { id: string; price: ModelPrice } | null {
  const file = join(piAgentDir(env), "models-store.json");
  if (!existsSync(file)) return null;
  let models: Array<{ id?: unknown; cost?: unknown }> = [];
  try {
    models = JSON.parse(readFileSync(file, "utf8"))?.anthropic?.models ?? [];
  } catch {
    return null;
  }
  const priced = models.filter((m): m is { id: string; cost: ModelPrice } => typeof m.id === "string" && !!m.cost && typeof (m.cost as ModelPrice).input === "number");
  const exact = model ? priced.find((m) => m.id === model) : undefined;
  if (exact) return { id: exact.id, price: exact.cost };
  if (!family) return null;
  const version = (id: string) => (/-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id) ?? []).slice(1).map((n) => Number(n ?? 0));
  const newest = priced
    .filter((m) => new RegExp(`^claude-${family}-\\d`).test(m.id))
    .sort((a, b) => {
      const [a1 = 0, a2 = 0] = version(a.id);
      const [b1 = 0, b2 = 0] = version(b.id);
      return b1 - a1 || b2 - a2;
    })[0];
  return newest ? { id: newest.id, price: newest.cost } : null;
}

/** What a call cost at `price` (US$). */
export function priceOf(t: CcTokens, price: ModelPrice): number {
  const input = num(t.input_tokens);
  const read = num(t.cache_read_input_tokens);
  const write = num(t.cache_creation_input_tokens);
  const tier = [...(price.tiers ?? [])].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove).find((x) => input + read + write > x.inputTokensAbove);
  const p = tier ?? price;
  return (input * p.input + num(t.output_tokens) * p.output + read * p.cacheRead + write * p.cacheWrite) / 1e6;
}
