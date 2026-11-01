// Opt-in chat import (rel-import): scan (read-only, for the estimate and the usage warning), then
// stage and run in the background after setup. Uses pi-optchat's own CLI from the bundle.
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { run, spawnDetached, withoutHerdrPaneVars } from "./util.mjs";

const NODE_FLAGS = ["--experimental-transform-types", "--no-warnings"];

/** pi-optchat imports pi's packages at runtime (`run`); point its node_modules at the bundled pi. */
export function linkOptchatPeers(L) {
  const piModules = join(L.app, "pi", "node_modules");
  const dest = join(L.app, "optchat", "node_modules", "@earendil-works");
  mkdirSync(dest, { recursive: true });
  const links = [[join(L.app, "pi"), join(dest, "pi-coding-agent")]];
  for (const name of ["pi-ai", "pi-agent-core", "pi-tui"]) links.push([join(piModules, "@earendil-works", name), join(dest, name)]);
  links.push([join(piModules, "typebox"), join(L.app, "optchat", "node_modules", "typebox")]);
  for (const [from, to] of links) {
    if (existsSync(from) && !existsSync(to)) symlinkSync(from, to);
  }
}

function cli(L) {
  return join(L.app, "optchat", "src", "import", "cli.ts");
}

/** Read-only scan: projects, message count, estimate and the warning copy for `subscription`. */
export async function scanHistory(L, subscription, { home = L.home } = {}) {
  const r = await run(L.node, [...NODE_FLAGS, cli(L), "scan", "--home", home, "--subscription", subscription, "--json"], {
    timeout: 120_000,
    env: { ...process.env, OPTCHAT_HOME: L.optchatHome },
  });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n").pop() };
  try {
    const s = JSON.parse(r.stdout);
    return {
      ok: true,
      messages: s.messages,
      projects: s.projects.filter((p) => p.ticked).length,
      warning: s.warning,
      usd: s.estimate?.usd?.mid ?? 0,
      hours: s.estimate?.hours ?? 0,
      timing: s.timing,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Stages the import into `profile` and starts the build as a background process (it pauses at a
 * rate limit; `dinobot import-status` shows progress). Returns the pid and log path.
 */
export async function startImport(L, profile) {
  linkOptchatPeers(L);
  const env = { ...withoutHerdrPaneVars(process.env), OPTCHAT_HOME: L.optchatHome, PATH: `${L.bin}:${process.env.PATH ?? ""}` };
  const staged = await run(L.node, [...NODE_FLAGS, cli(L), "start", profile], { env, timeout: 300_000 });
  if (staged.code !== 0) return { ok: false, error: (staged.stderr || staged.stdout).trim() };
  const log = join(L.logs, `import-${profile}.log`);
  // Test hook: stage only, no model calls.
  if (process.env.DINOBOT_IMPORT_RUN === "0") return { ok: true, staged: staged.stdout.trim(), pid: null, log };
  const pid = spawnDetached(L.node, [...NODE_FLAGS, cli(L), "run", profile], { env, cwd: L.home, log });
  return { ok: true, staged: staged.stdout.trim(), pid, log };
}

export async function importStatus(L, profile) {
  const r = await run(L.node, [...NODE_FLAGS, cli(L), "status", profile], { env: { ...process.env, OPTCHAT_HOME: L.optchatHome } });
  return r.stdout.trim() || r.stderr.trim();
}
