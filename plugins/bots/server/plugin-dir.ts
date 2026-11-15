/**
 * Where the bots plugin's files are on disk. Paseo compiles the plugin into one bundle and evaluates it from its own
 * install (bundle-evaluator.js), so `__dirname`, `import.meta.url` and bare-name resolution all point into Paseo,
 * not here. What does: `plugins.bots.path` in $PASEO_HOME/config.json (a source checkout as well as an install).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `plugins.bots.path` from Paseo's config; null without one. */
export function configuredPluginDir(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const home = env.PASEO_HOME || join(env.HOME || homedir(), ".paseo");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { plugins?: { bots?: { path?: unknown } } };
    const path = cfg.plugins?.bots?.path;
    return typeof path === "string" && path ? path : null;
  } catch {
    return null;
  }
}

/** The installed plugin (~/.dinobot/app/bots, or $DINOBOT_HOME/app/bots). */
export function installedPluginDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DINOBOT_HOME ?? join(env.HOME || homedir(), ".dinobot"), "app", "bots");
}

/** The plugin folders to look in, most specific first: Paseo's config, then the install. */
export function botsPluginDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [configuredPluginDir(env), installedPluginDir(env)].filter((d): d is string => !!d);
  return [...new Set(dirs)];
}
