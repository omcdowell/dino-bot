#!/usr/bin/env node
// The engine and model a worker starts on when launch.sh is given none (no --engine, no WORKER_ENGINE/WORKER_MODEL).
// Prints two lines: the engine (pi or cc) and the model (provider/model:thinking, or empty). Read at every launch,
// so a change applies to the next worker without restarting the bot.
//
// Engine, first that is set:
//   1. WORKER_ENGINE                       this launch only (the bot's shell)
//   2. <bot folder>/.bot.json workers.engine   this bot's default ("pi" or "cc"; the bot sets it when the user asks)
//   3. <bots root>/.settings.json workerEngine  everyone's default (the app: Settings › Host › Agents › Workers)
//   4. automatic: Claude Code when it is signed in (`claude auth status`, or a proxy in CC_WORKER_BASE_URL), else pi
// Model: WORKER_MODEL, else .bot.json workers.model, else the host's worker model (settings models.workers, as
// BOTS_WORKER_MODEL), else empty (the engine's own default).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const home = env.HOME || homedir();
const json = (path) => {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const engineOf = (v) => (v === "pi" || v === "cc" ? v : "");
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

const root = env.PASEO_BOTS_ROOT || join(home, "bots");
const settings = json(env.PASEO_BOTS_SETTINGS || join(root, ".settings.json"));
const bot = env.BOT && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(env.BOT) ? json(join(root, env.BOT, ".bot.json")) : {};
const own = bot.workers && typeof bot.workers === "object" ? bot.workers : {};

/** Claude Code is signed in for workers: a proxy that holds the login, or `claude auth status` says logged in. */
function claudeSignedIn() {
  if (str(env.CC_WORKER_BASE_URL)) return true;
  const cfg = str(env.DINOBOT_CLAUDE_CONFIG_DIR) || str(env.CC_WORKER_CONFIG_DIR);
  const clean = { ...env, ...(cfg ? { CLAUDE_CONFIG_DIR: cfg } : {}) };
  // In a Claude Code bot's shell CLAUDE_CONFIG_DIR is the bot's own TUI folder (with a proxy, one with no login); a
  // worker's pane does not inherit it (launch-cc.sh), so check the login the worker gets: the user's own.
  if (!cfg && env.OPTCHAT_ENGINE_FILE) delete clean.CLAUDE_CONFIG_DIR;
  for (const k of Object.keys(clean)) if (/^ANTHROPIC_/.test(k)) delete clean[k];
  try {
    const out = execFileSync("claude", ["auth", "status", "--json"], { env: clean, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out).loggedIn === true;
  } catch {
    return false;
  }
}

const engine = engineOf(env.WORKER_ENGINE) || engineOf(own.engine) || engineOf(settings.workerEngine) || (claudeSignedIn() ? "cc" : "pi");

const pick = settings.models?.workers;
const hostModel =
  pick && str(pick.provider) && str(pick.model) ? `${str(pick.provider)}/${str(pick.model)}${str(pick.thinking) ? `:${str(pick.thinking)}` : ""}` : str(env.BOTS_WORKER_MODEL);
let model = str(env.WORKER_MODEL) || str(own.model) || hostModel;
// A Claude Code model from setup (claude-code/<model>) means nothing to pi: a pi worker then runs on pi's own default.
if (engine === "pi" && model.startsWith("claude-code/")) model = "";

process.stdout.write(`${engine}\n${model}\n`);
