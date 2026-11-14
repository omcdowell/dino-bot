// Onboarding on the phone (SETUP_FLOW.signIn === "phone"): the bots plugin's signin.* and
// setup.* RPCs call this module inside the daemon (it finds it through DINOBOT_HOME).
//
// pi is the infrastructure (owner decision, 27 Oct): the logins are pi-ai's own OAuth flows (device code /
// copy code) or an API key, stored in pi's auth.json in DinoBot's pi dir; readiness is
// `pi auth check --provider <p> --json`; the model list is pi's `get_available_models` (RPC mode)
// after one `pi update --models`; effort levels come from each model's thinkingLevelMap. Nothing
// here keeps its own list of providers, models or levels: the sign-in option list is the bots
// plugin's (shared/sign-in.ts) and the suggested models are pi-optchat's defaults table, used only
// as preferences and checked against pi's live list.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createStarterBot } from "./bots.mjs";
import { CLAUDE_CODE_OPTION_ID, claudeCodeLogout, claudeCodeStatus, piCard, removePiCredential, startClaudeCodeLogin } from "./engines.mjs";
import { DEFAULT_PI_PACKAGES, readEnvFile, writeDaemonConfig } from "./config.mjs";
import { subscriptionFor } from "./detect.mjs";
import { startImport, scanHistory } from "./importer.mjs";
import { ProviderJobs } from "./provider-install.mjs";
import { providerOverrides } from "./provider-overrides.mjs";
import { listProviders } from "./providers.mjs";
import { loadModelDefaults, signIn, signInOptions } from "./signin.mjs";
import { layout, readJson, writeJson } from "./util.mjs";

const PUBLIC_FIELDS = ["id", "provider", "label", "method", "note", "badge", "confirm"];

/** pi's own CLI (DinoBot's wrapper pins PI_CODING_AGENT_DIR). -> {code, stdout, stderr} */
function pi(L, args, { input = null, timeoutMs = 60_000, until = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(join(L.bin, "pi"), args, { env: { ...process.env, PI_CODING_AGENT_DIR: L.piAgentDir }, cwd: L.home, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => finish(124), timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (until && until(stdout)) finish(0);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", () => finish(127));
    if (input !== null) child.stdin.write(input);
    if (!until) child.stdin.end();
  });
}

/** `pi auth check --provider <p> --json` -> {status:"ready"|"not_ready", reason?, authType?}. */
export async function authCheck(L, provider) {
  const r = await pi(L, ["auth", "check", "--provider", provider, "--json"], { timeoutMs: 30_000 });
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return { status: "not_ready", provider, reason: (r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}` };
  }
}

/** Providers with a credential in DinoBot's auth.json that pi says are ready. */
export async function readyProviders(L) {
  const auth = readJson(join(L.piAgentDir, "auth.json"), {}) ?? {};
  const out = [];
  for (const provider of Object.keys(auth)) {
    const c = await authCheck(L, provider);
    if (c.status === "ready") out.push(provider);
  }
  return out;
}

/** `pi update --models`: refresh pi's model catalogs (models-store.json) once, after sign-in. */
export async function refreshCatalog(L) {
  const r = await pi(L, ["update", "--models"], { timeoutMs: 60_000 });
  return { ok: r.code === 0, detail: (r.stdout || r.stderr).trim().split("\n").pop() ?? "" };
}

/** pi's own list of models it can use now (RPC get_available_models). */
export async function availableModels(L) {
  const req = `${JSON.stringify({ id: "models", type: "get_available_models" })}\n`;
  const r = await pi(L, ["--mode", "rpc", "--no-session"], {
    input: req,
    timeoutMs: 60_000,
    // The answer is one (long) JSON line: wait for its end, not just its start.
    until: (out) => /"command":"get_available_models"[^\n]*\n/.test(out),
  });
  for (const line of r.stdout.split("\n")) {
    try {
      const msg = JSON.parse(line);
      if (msg.command === "get_available_models") {
        if (!msg.success) throw new Error(msg.error ?? "pi refused get_available_models");
        return msg.data.models;
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
  throw new Error(`pi did not list its models (${(r.stderr || "no answer").trim().slice(0, 200)})`);
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/**
 * Effort levels a model supports, from pi's model data (the same rule as pi-ai's
 * getSupportedThinkingLevels): none without reasoning; a null in thinkingLevelMap means
 * unsupported; xhigh/max only when the map names them. [] = no effort picker.
 */
export function effortLevels(model) {
  if (!model?.reasoning) return [];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** The closest supported level (pi-ai clampThinkingLevel), or null when the model has none. */
export function clampEffort(levels, wanted) {
  if (!levels.length) return null;
  if (levels.includes(wanted)) return wanted;
  const i = LEVELS.indexOf(wanted);
  for (let j = i; j >= 0 && j < LEVELS.length; j++) if (levels.includes(LEVELS[j])) return LEVELS[j];
  for (let j = i - 1; j >= 0; j--) if (levels.includes(LEVELS[j])) return LEVELS[j];
  return levels[0];
}

export const ROLES = ["bots", "compaction", "workers"];

/**
 * Model step data: pi's live models for the signed-in providers, each with its effort levels, and
 * a suggestion per role from pi-optchat's defaults table (a preference: used only if pi lists that
 * model; else the first model of the same provider; effort clamped to what the model supports).
 */
export async function modelChoices(L, { refresh = false } = {}) {
  if (refresh) await refreshCatalog(L);
  const providers = await readyProviders(L);
  const all = await availableModels(L);
  const models = all
    .filter((m) => providers.includes(m.provider))
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, levels: effortLevels(m) }));
  const md = await loadModelDefaults(L.app);
  const subs = providers.map((p) => readSubscription(L, p)).filter(Boolean);
  const subscription = md.pickSubscription(subs) ?? null;
  const row = subscription ? md.MODEL_DEFAULTS[subscription] : null;
  const pick = (pref) => {
    let m = pref ? models.find((x) => x.provider === pref.provider && x.id === pref.model) : null;
    if (!m) m = models.find((x) => x.provider === (pref?.provider ?? providers[0])) ?? models[0];
    if (!m) return null;
    return { provider: m.provider, model: m.id, thinking: clampEffort(m.levels, pref?.thinking ?? "medium") };
  };
  const suggested = { bots: pick(row?.main), compaction: pick(row?.compaction), workers: pick(row?.worker) };
  return { providers, subscription, models, suggested };
}

/**
 * "Already signed in: …" in the list's own words ("ChatGPT (Codex)", not pi's "openai-codex"):
 * the option for that provider and kind of sign-in (API key or login), else the provider id.
 */
export function signedInLabels(list, providers, auth = {}) {
  return providers.map((p) => {
    const key = auth[p]?.type === "api_key";
    const same = list.filter((o) => o.provider === p);
    return (same.find((o) => (o.method === "api-key") === key) ?? same[0])?.label ?? p;
  });
}

function readSubscription(L, provider) {
  const auth = readJson(join(L.piAgentDir, "auth.json"), {}) ?? {};
  const type = auth[provider]?.type === "api_key" ? "api_key" : "oauth";
  return subscriptionFor(provider, type);
}

/**
 * The phone sign-in, one session per attempt. The app polls status(): it shows the device code and
 * link, or asks for the pasted code or key, which submit() hands to pi-ai's login.
 */
export class PhoneSignIn {
  constructor(L, env = process.env, { overrides = providerOverrides, claudeLogin = startClaudeCodeLogin } = {}) {
    this.L = L;
    this.env = env;
    this.overrides = overrides;
    this.claudeLogin = claudeLogin;
    this.sessions = new Map();
    // Claude Code logins (engines.mjs), by session id: the same signin.status/submit/cancel.
    this.claude = new Map();
  }

  /** The sign-in list, worded for the provider plugins added on this computer (Claude via a plugin). */
  async list() {
    const overrides = await Promise.resolve(this.overrides(this.L)).catch(() => []);
    return signInOptions(this.L.app, this.env, { overrides });
  }

  async options() {
    const list = await this.list();
    const providers = await readyProviders(this.L);
    const auth = readJson(join(this.L.piAgentDir, "auth.json"), {}) ?? {};
    return {
      options: list.map((o) => Object.fromEntries(PUBLIC_FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))),
      signedIn: signedInLabels(list, providers, auth),
    };
  }

  async start({ optionId, confirmed = false }) {
    // Not a pi sign-in: Claude Code's own login (Settings › Providers › Claude Code card).
    if (optionId === CLAUDE_CODE_OPTION_ID) {
      const login = this.claudeLogin(this.env);
      this.claude.set(login.session.id, login);
      return this.status({ sessionId: login.session.id });
    }
    const list = await this.list();
    const option = list.find((o) => o.id === optionId);
    if (!option) throw new Error("Unknown sign-in option.");
    // Claude login (EXTRA USAGE, or via a plugin: unofficial): the app shows the confirm sheet;
    // without its yes, no login starts.
    if (option.confirm && !confirmed) throw new Error(`${option.confirm.title}: confirm first.`);
    const s = { id: randomUUID(), provider: option.provider, label: option.label, state: "running", url: null, code: null, instructions: null, prompt: null, error: null, waiter: null, startedAt: Date.now() };
    this.sessions.set(s.id, s);
    const prompter = {
      answers: {},
      ask: (id, question) => {
        if (id.startsWith("confirm:")) return "y"; // confirmed in the app above
        return new Promise((resolve) => {
          s.prompt = { kind: id.startsWith("key:") ? "key" : "code", message: question };
          s.state = "needs-input";
          s.waiter = resolve;
        });
      },
      choose: (_id, _q, _options, def) => def,
    };
    const sink = { write: () => true };
    const onEvent = (event) => {
      if (event.type === "auth_url") {
        s.url = event.url;
        s.instructions = event.instructions ?? null;
      } else if (event.type === "device_code") {
        s.url = event.verificationUri;
        s.code = event.userCode;
      }
    };
    signIn(this.L, option, prompter, sink, onEvent)
      .then(async (done) => {
        const check = await authCheck(this.L, done.provider);
        if (check.status !== "ready") throw new Error(`pi says ${done.provider} is not ready (${check.reason ?? "unknown"})`);
        const state = readJson(this.L.state, {}) ?? {};
        writeJson(this.L.state, { ...state, subscription: done.subscription }, 0o600);
        s.state = "done";
        s.prompt = null;
      })
      .catch((e) => {
        s.state = "error";
        s.error = e.message;
        s.prompt = null;
      });
    return this.status({ sessionId: s.id });
  }

  submit({ sessionId, text }) {
    const cc = this.claude.get(sessionId);
    if (cc) {
      cc.submit(text);
      return this.status({ sessionId });
    }
    const s = this.sessions.get(sessionId);
    if (!s || !s.waiter) throw new Error("Nothing is waiting for input.");
    const w = s.waiter;
    s.waiter = null;
    s.prompt = null;
    s.state = "running";
    w(String(text ?? "").trim());
    return this.status({ sessionId });
  }

  status({ sessionId }) {
    const s = this.sessions.get(sessionId) ?? this.claude.get(sessionId)?.session;
    if (!s) throw new Error("Unknown sign-in.");
    return { sessionId: s.id, provider: s.provider, label: s.label, state: s.state, url: s.url, code: s.code, instructions: s.instructions, prompt: s.prompt, error: s.error };
  }

  cancel({ sessionId }) {
    const cc = this.claude.get(sessionId);
    if (cc) {
      cc.cancel();
      this.claude.delete(sessionId);
      return { ok: true };
    }
    const s = this.sessions.get(sessionId);
    if (s?.waiter) s.waiter("");
    this.sessions.delete(sessionId);
    return { ok: true };
  }
}

/** pi's model string with effort: "provider/model:thinking" (pi --model syntax). */
export function piModelArg(choice) {
  return choice.thinking ? `${choice.provider}/${choice.model}:${choice.thinking}` : `${choice.provider}/${choice.model}`;
}

/**
 * Host files the installer owns, after the model step: the daemon's "bot" agent profile keeps no
 * model (the plugin's settings decide), state.json records the choice. The plugin writes the
 * rest itself (settings, bots, pi defaults for workers).
 */
export function recordModels(L, models) {
  writeDaemonConfig(L, { mainModel: null, thinking: null });
  const state = readJson(L.state, {}) ?? {};
  writeJson(L.state, { ...state, models }, 0o600);
}

export async function importScan(L) {
  const state = readJson(L.state, {}) ?? {};
  if (!state.subscription || !state.starterBot) return { ok: false, reason: "no sign-in or starter bot" };
  return scanHistory(L, state.subscription);
}

export async function importStart(L) {
  const state = readJson(L.state, {}) ?? {};
  if (!state.starterBot) return { ok: false, error: "no starter bot" };
  return startImport(L, state.starterBot);
}

/** For the plugin: one object per daemon. */
export function createOnboarding(env = process.env) {
  const L = layout(env);
  const signin = new PhoneSignIn(L, env);
  const providers = new ProviderJobs(L, {
    listPackages: () => listProviders(L, DEFAULT_PI_PACKAGES),
    overrides: ({ fresh }) => providerOverrides(L, { fresh }),
    signInOptions: () => signin.list(),
    authCheck: (provider) => authCheck(L, provider),
    authTypes: () => {
      const auth = readJson(join(L.piAgentDir, "auth.json"), {}) ?? {};
      return Object.fromEntries(Object.entries(auth).map(([p, c]) => [p, c?.type === "api_key" ? "api_key" : "oauth"]));
    },
    refreshCatalog: () => refreshCatalog(L),
  });
  return {
    // Settings → Providers on the phone (bots plugin provider.* RPCs; provider-install.mjs).
    providerList: () => providers.list(),
    providerInstall: (input) => providers.install(input),
    providerInstallStatus: (input) => providers.status(input),
    providerRemove: (input) => providers.remove(input),
    // Settings › Providers, "Two engines" (engines.mjs): the pi card and the Claude Code card.
    enginesStatus: async () => {
      const [list, claudeCode] = await Promise.all([providers.list(), claudeCodeStatus(env)]);
      return { pi: piCard(list, readJson(join(L.piAgentDir, "auth.json"), {}) ?? {}), claudeCode };
    },
    piSignOut: ({ provider }) => removePiCredential(L, provider),
    claudeLogout: () => claudeCodeLogout(env),
    layout: L,
    options: () => signin.options(),
    start: (input) => signin.start(input),
    submit: (input) => signin.submit(input),
    status: (input) => signin.status(input),
    cancel: (input) => signin.cancel(input),
    models: (input = {}) => modelChoices(L, input),
    recordModels: (models) => recordModels(L, models),
    importScan: () => importScan(L),
    importStart: () => importStart(L),
    envFile: () => readEnvFile(L.envFile),
    createStarterBot: (opts) => createStarterBot(L, opts),
  };
}
