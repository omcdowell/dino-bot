/**
 * The models a Claude Code bot can run on, for the app's model picker: Claude Code's aliases first (each follows the
 * newest model of its family), then the full model ids the Anthropic Models API lists, newest first.
 *
 * Claude Code has no "list models" command. With a gateway (ANTHROPIC_BASE_URL) it asks `<base>/v1/models` itself
 * ("gatewayDiscovery"), so a bot behind the owner's proxy (launch.ts ccProxyFor) asks the same place with the same
 * token. Without a proxy the bot runs on its Claude login, so the list comes from api.anthropic.com with that login's
 * OAuth token (`anthropic-beta: oauth-2025-04-20`). Lists are cached per source an hour; when none can be had the
 * aliases alone are offered (and that is logged once). Tokens are never logged.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ccProxyFor } from "./launch";

export interface CcModel {
  id: string;
  label: string;
  description?: string;
  /** The effort levels the model takes (Models API capabilities); absent when not known. */
  thinkingOptions?: Array<{ id: string; label: string }>;
}

/** Claude Code's effort levels, in order. */
export const CC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const effortOption = (id: string) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) });

/** Claude Code's model aliases (each resolves to the newest model of its family), kept at the top of the list. */
export const CC_ALIASES: readonly CcModel[] = [
  { id: "opus", label: "Opus", description: "The latest Opus (Claude Code alias)" },
  { id: "sonnet", label: "Sonnet", description: "The latest Sonnet (Claude Code alias)" },
  { id: "haiku", label: "Haiku", description: "The latest Haiku (Claude Code alias)" },
  { id: "fable", label: "Fable", description: "The latest Fable (Claude Code alias)" },
];

export const ANTHROPIC_API = "https://api.anthropic.com";
const VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/** Where a bot's model list comes from: `key` names the source (never the token) for the cache and the log. */
export interface ModelSource {
  key: string;
  baseUrl: string;
  headers: Record<string, string>;
}

/** The Claude login's OAuth access token in a Claude Code config folder, if there is a current one. */
export function oauthToken(configDir: string, now = Date.now()): string | null {
  try {
    const creds = JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8")) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const o = creds.claudeAiOauth;
    if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
    if (typeof o.expiresAt === "number" && o.expiresAt <= now) return null;
    return o.accessToken;
  } catch {
    return null;
  }
}

/**
 * The source for a bot (its folder, `cwd`) or, with no bot, for the daemon: the bot's proxy (`cc.baseUrl` in .bot.json,
 * else DINOBOT_CC_BASE_URL), else the Claude login the bot's TUI uses (DINOBOT_CLAUDE_CONFIG_DIR, else
 * CLAUDE_CONFIG_DIR, else ~/.claude). Null when there is neither.
 */
export function modelSource(cwd: string | undefined, env: Record<string, string | undefined> = process.env, now = Date.now()): ModelSource | null {
  const proxy = ccProxyFor(cwd ?? "", env);
  if (proxy) {
    const baseUrl = proxy.baseUrl.replace(/\/+$/, "");
    return { key: baseUrl, baseUrl, headers: { authorization: `Bearer ${proxy.authToken}`, "x-api-key": proxy.authToken, "anthropic-version": VERSION } };
  }
  const configDir = env.DINOBOT_CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const token = oauthToken(configDir, now);
  if (!token) return null;
  return {
    key: `${ANTHROPIC_API} (login ${configDir})`,
    baseUrl: ANTHROPIC_API,
    headers: { authorization: `Bearer ${token}`, "anthropic-version": VERSION, "anthropic-beta": OAUTH_BETA },
  };
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ApiModel {
  id: string;
  display_name?: string;
  created_at?: string;
  /** `effort`: `{ supported, low: { supported }, … }` per level. */
  capabilities?: { effort?: { supported?: boolean } & Record<string, unknown> } | null;
}

/** The effort levels a model takes, as the Models API lists them; undefined when it says nothing. */
function efforts(m: ApiModel): CcModel["thinkingOptions"] {
  const e = m.capabilities?.effort;
  if (!e || typeof e !== "object") return undefined;
  if (e.supported !== true) return [];
  return CC_EFFORTS.filter((l) => (e[l] as { supported?: unknown } | undefined)?.supported === true).map(effortOption);
}

/** Every model `<base>/v1/models` lists (all pages), newest first. Throws on an HTTP error or an odd answer. */
export async function fetchModels(source: ModelSource, fetchFn: Fetch = fetch as unknown as Fetch, timeoutMs = 8_000, maxPages = 20): Promise<ApiModel[]> {
  const out: ApiModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (after) q.set("after_id", after);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r: Awaited<ReturnType<Fetch>>;
    let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
    try {
      r = await fetchFn(`${source.baseUrl}/v1/models?${q}`, { headers: source.headers, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = (await r.json()) as typeof body;
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(body.data)) throw new Error("no model list in the answer");
    for (const m of body.data as ApiModel[]) if (m && typeof m.id === "string" && m.id) out.push(m);
    const last = typeof body.last_id === "string" && body.last_id ? body.last_id : out.at(-1)?.id;
    if (body.has_more !== true || !last || last === after) break;
    after = last;
  }
  const time = (m: ApiModel) => (m.created_at ? Date.parse(m.created_at) || 0 : 0);
  // Newest first; the API's own order breaks ties.
  return out.map((m, i) => ({ m, i })).sort((a, b) => time(b.m) - time(a.m) || a.i - b.i).map(({ m }) => m);
}

/** The picker's list: the aliases, then the full ids (deduplicated) labelled with their display names. */
export function pickerModels(api: readonly ApiModel[]): CcModel[] {
  const seen = new Set(CC_ALIASES.map((m) => m.id));
  // An alias takes the effort levels of its family's newest model (the API lists newest first).
  const list: CcModel[] = CC_ALIASES.map((m) => {
    const newest = api.find((a) => a.id.startsWith(`claude-${m.id}-`));
    const t = newest && efforts(newest);
    return { ...m, ...(t ? { thinkingOptions: t } : {}) };
  });
  for (const m of api) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const t = efforts(m);
    list.push({ id: m.id, label: m.display_name?.trim() || m.id, description: m.id, ...(t ? { thinkingOptions: t } : {}) });
  }
  return list;
}

/** A model id the session runs on stays pickable even when the list lacks it (an older id, or only aliases). */
export function withModel(list: readonly CcModel[], model: string | undefined): CcModel[] {
  if (!model || list.some((m) => m.id === model)) return [...list];
  return [...list, { id: model, label: model, description: model }];
}

export interface CcModelsOptions {
  fetch?: Fetch;
  warn?: (s: string) => void;
  ttlMs?: number;
  /** How long a failed source waits before it is asked again. */
  retryMs?: number;
  now?: () => number;
}

/** Model lists per source, cached; aliases alone when a source fails (logged once until it works again). */
export class CcModels {
  private readonly cache = new Map<string, { at: number; ttl: number; models: CcModel[] }>();
  private readonly pending = new Map<string, Promise<CcModel[]>>();
  private readonly failing = new Set<string>();
  constructor(private readonly opts: CcModelsOptions = {}) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** The list for a bot's folder (or none: the daemon's default source). */
  async list(cwd: string | undefined, env: Record<string, string | undefined> = process.env): Promise<CcModel[]> {
    const source = modelSource(cwd, env, this.now());
    if (!source) {
      this.fail("no-source", "no proxy and no current Claude login to ask");
      return CC_ALIASES.map((m) => ({ ...m }));
    }
    this.failing.delete("no-source");
    const hit = this.cache.get(source.key);
    if (hit && this.now() - hit.at < hit.ttl) return hit.models;
    const running = this.pending.get(source.key);
    if (running) return running;
    const work = (async () => {
      try {
        const models = pickerModels(await fetchModels(source, this.opts.fetch));
        this.cache.set(source.key, { at: this.now(), ttl: this.opts.ttlMs ?? 60 * 60_000, models });
        this.failing.delete(source.key);
        return models;
      } catch (error) {
        this.fail(source.key, (error as Error).message);
        const models = CC_ALIASES.map((m) => ({ ...m }));
        this.cache.set(source.key, { at: this.now(), ttl: this.opts.retryMs ?? 5 * 60_000, models });
        return models;
      } finally {
        this.pending.delete(source.key);
      }
    })();
    this.pending.set(source.key, work);
    return work;
  }

  private fail(key: string, why: string) {
    if (this.failing.has(key)) return;
    this.failing.add(key);
    this.opts.warn?.(`cc models: cannot list Claude models from ${key} (${why}); offering the aliases only`);
  }
}
