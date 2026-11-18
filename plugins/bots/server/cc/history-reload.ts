/**
 * A new Claude Code chat shows the bot's history (BF2 bug 4). Paseo opens a new chat with history "skip" and keeps
 * only notices from its opening, so a chat made for a bot whose OptChat profile already has a log looked empty until
 * a refresh. Once it is made, the chat is reloaded (`paseo agent reload`, the daemon's refresh_agent_request), which
 * resumes it with history "replay": the provider replays the log (provider.ts replayItems) and the app gets the rows.
 * The CLI is the daemon's own (found as bot-dm/paseo.ts cliDist finds it; plugin server code may not import from
 * bot-dm/, the plugin bundler refuses modules outside client/, server/ and shared/), run with the daemon's node;
 * nothing waits on it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configuredPluginDir } from "../plugin-dir";
import { hasMemory } from "./engine";
import { resolveBot } from "./provider";

/** The paseo CLI's dist, in bot-dm/paseo.ts cliDist's order: $PASEO_CLI_DIST, the daemon beside the plugin, the
 *  DinoBot install's daemon, then the global npm CLI. */
export function paseoCliDist(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_CLI_DIST) return env.PASEO_CLI_DIST;
  const pluginDir = configuredPluginDir(env);
  const candidates = pluginDir ? [join(dirname(pluginDir), "daemon", "dist")] : [];
  if (env.DINOBOT_HOME) candidates.push(join(env.DINOBOT_HOME, "app", "daemon", "dist"));
  for (const dist of candidates) {
    if (existsSync(join(dist, "utils", "client.js"))) return resolve(dist);
  }
  return join(env.HOME || homedir(), ".local/lib/node_modules/@getpaseo/cli/dist");
}

export type Run = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail: string }>;

const runFile: Run = (file, args, env) =>
  new Promise((done) =>
    execFile(file, args, { env, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
      done({ ok: !error, detail: (error ? `${error.message} ${stderr}` : stdout).trim().slice(0, 300) }),
    ),
  );

export interface HistoryReloadDeps {
  botsRoot: string;
  optchatHome: string;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  warn?: (s: string) => void;
}

/** Reloads a new Claude Code chat when its bot's profile has a log; resolves true when a reload ran and worked. */
export async function reloadIfHistory(cwd: string, agentId: string, deps: HistoryReloadDeps): Promise<boolean> {
  let profileDir: string;
  try {
    profileDir = resolveBot(cwd, deps.botsRoot, deps.optchatHome).profileDir;
  } catch {
    return false;
  }
  if (!hasMemory(profileDir)) return false;
  const env = { ...(deps.env ?? process.env) };
  // Run as the host, not as an agent (as bot-dm-send.ts), against the daemon's default home.
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_HOST;
  const bin = join(paseoCliDist(env), "..", "bin", "paseo");
  const r = await (deps.run ?? runFile)(process.execPath, ["--disable-warning=DEP0040", bin, "agent", "reload", agentId], env);
  if (!r.ok) deps.warn?.(`[bots] new Claude Code chat ${agentId}: reload for its history failed: ${r.detail}`);
  return r.ok;
}
