// Small shared helpers: layout, files, child processes, prompts, step timing.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, closeSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

// Names come from lib/product.json only (the one place to change them).
const product = JSON.parse(readFileSync(new URL("./product.json", import.meta.url), "utf8"));
export const PRODUCT = product.name; // shown to users
export const PRODUCT_ID = product.id; // command, ~/.<id>, service names
export const BUNDLE_ID = product.bundleId;
export const DOWNLOAD_BASE_URL = product.downloadBaseUrl;
export const RELEASE_REPO = product.releaseRepo; // owner/repo of the GitHub releases
// Pairing link scheme: the app's, derived from the name exactly as rel-app2's release-flavour.js
// does (PUBLIC_LINK_SCHEME), so dinobot://pair/#offer=… opens the app.
export const LINK_SCHEME = product.name.toLowerCase().replace(/[^a-z0-9+.-]/g, "");

/** Every path the installer writes. Nothing points into a dev checkout. */
export function layout(env = process.env) {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set");
  const root = env.DINOBOT_HOME || join(home, `.${PRODUCT_ID}`);
  const app = join(root, "app");
  return {
    home,
    root,
    app,
    bin: join(root, "bin"),
    node: join(app, "node", "bin", "node"),
    paseoHome: join(root, "paseo"),
    envFile: join(root, "daemon.env"),
    state: join(root, "state.json"),
    logs: join(root, "logs"),
    botsRoot: env.PASEO_BOTS_ROOT || join(home, "bots"),
    optchatHome: env.OPTCHAT_HOME || join(home, ".optchat"),
    // DinoBot's own pi dir (split by default, owner decision). The user's ~/.pi is never written;
    // it is only read for API keys (userPiDir). PI_CODING_AGENT_DIR from the caller's env is
    // ignored on purpose: it would be the user's own pi.
    piAgentDir: env.DINOBOT_PI_DIR || join(root, "pi"),
    userPiDir: join(home, ".pi", "agent"),
  };
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Atomic write (tmp + rename) with a mode; creates the parent directory. */
export function writeFileAtomic(path, data, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function writeJson(path, value, mode = 0o644) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** execFile as a promise; never throws, resolves {code, stdout, stderr}. */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error });
    });
  });
}

/** Start a detached background process with output to a log file. Returns its pid. */
export function spawnDetached(cmd, args, { env, cwd, log }) {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  const child = spawn(cmd, args, { env, cwd, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  closeSync(fd);
  return child.pid;
}

/** HERDR_* pane variables override HERDR_SESSION (rel-plugin); never pass them on. */
export const HERDR_PANE_VARS = [
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
];
export function withoutHerdrPaneVars(env) {
  const out = { ...env };
  for (const key of HERDR_PANE_VARS) delete out[key];
  return out;
}

// ---------------------------------------------------------------- prompts
/**
 * Questions read from the terminal (/dev/tty, so `curl | sh` works). With answers given by flag,
 * env or --yes, nothing is asked. `answers` is a map of question id -> preset answer.
 */
export class Prompter {
  constructor({ answers = {}, assumeYes = false, input = null, output = process.stdout } = {}) {
    this.answers = answers;
    this.assumeYes = assumeYes;
    this.output = output;
    this.input = input; // array of scripted lines (tests)
    this.asked = []; // shown to the user and answered at the terminal
    this.shown = []; // every question this run had, including preset answers (for the count)
  }
  line(question) {
    if (Array.isArray(this.input)) return this.input.shift() ?? "";
    let fd;
    try {
      fd = openSync("/dev/tty", "r");
    } catch {
      return "";
    }
    this.output.write(question);
    const buf = Buffer.alloc(1);
    let text = "";
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, 1, null);
        if (n === 0 || buf[0] === 10) break;
        text += buf.toString("utf8");
      }
    } finally {
      closeSync(fd);
    }
    return text.replace(/\r$/, "");
  }
  /** Free text with a default (Enter keeps it). */
  ask(id, question, def = "") {
    this.shown.push(id);
    if (id in this.answers) return String(this.answers[id]);
    if (this.assumeYes) return def;
    this.asked.push(id);
    const got = this.line(`${question}${def ? ` [${def}]` : ""}: `).trim();
    return got || def;
  }
  /** Pick one of `options` ([{id,label,note}]); Enter picks `def`. Returns the option id. */
  choose(id, question, options, def) {
    this.shown.push(id);
    if (id in this.answers) return String(this.answers[id]);
    if (this.assumeYes) return def;
    this.asked.push(id);
    this.output.write(`\n${question}\n`);
    options.forEach((o, i) => this.output.write(`  ${i + 1}. ${o.label}${o.note ? `  (${o.note})` : ""}${o.id === def ? "  <- Enter" : ""}\n`));
    const got = this.line("Choose a number: ").trim();
    const pick = options[Number(got) - 1];
    return pick ? pick.id : def;
  }
  /** A checklist on one screen: [{id,label,on}]. Typing numbers toggles; Enter accepts. */
  checklist(id, question, items) {
    this.shown.push(id);
    if (id in this.answers) {
      const on = new Set(String(this.answers[id]).split(",").map((s) => s.trim()).filter(Boolean));
      return Object.fromEntries(items.map((it) => [it.id, on.has(it.id)]));
    }
    const state = Object.fromEntries(items.map((it) => [it.id, Boolean(it.on)]));
    if (this.assumeYes) return state;
    this.asked.push(id);
    this.output.write(`\n${question}\n`);
    items.forEach((it, i) => this.output.write(`  [${state[it.id] ? "x" : " "}] ${i + 1}  ${it.label}\n${it.detail ? `${it.detail.replace(/^/gm, "         ")}\n` : ""}`));
    const got = this.line("Enter to accept, or type numbers to toggle (e.g. 2): ").trim();
    for (const part of got.split(/[ ,]+/).filter(Boolean)) {
      const it = items[Number(part) - 1];
      if (it) state[it.id] = !state[it.id];
    }
    return state;
  }
}

// ---------------------------------------------------------------- timing
export class Timer {
  constructor(t0 = Date.now()) {
    this.t0 = t0;
    this.steps = [];
    this.last = Date.now();
  }
  mark(step, extra = {}) {
    const now = Date.now();
    this.steps.push({ step, ms: now - this.last, atMs: now - this.t0, ...extra });
    this.last = now;
  }
  get elapsedMs() {
    return Date.now() - this.t0;
  }
  table() {
    return this.steps.map((s) => `  ${fmt(s.atMs).padStart(6)}  +${fmt(s.ms).padStart(6)}  ${s.step}`).join("\n");
  }
}
export function fmt(ms) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function exists(p) {
  return existsSync(p);
}
