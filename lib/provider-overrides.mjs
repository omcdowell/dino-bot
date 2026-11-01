// Which of pi's own providers an added provider plugin replaces. Generic on purpose: no plugin is
// named here or anywhere in the public build. pi itself is asked (provider-probe.mjs loads DinoBot's
// pi extensions in a child process, the way pi does at startup) which providers each extension
// registers; a registration with the id of a provider pi already has (e.g. "anthropic") replaces it.
//
// Used by the sign-in list (signin.mjs): when a plugin replaces "anthropic", the Claude login no
// longer says EXTRA USAGE but "your plan, via <plugin>" (unofficial; wording in the bots plugin's
// shared/sign-in.ts, claudeViaPlugin). The plugin's name is its own package's, read at run time.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./util.mjs";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "provider-probe.mjs");

/** "pi-foo_bar" / "@scope/foo-bar" -> "Pi Foo Bar" / "Foo Bar". */
export function humanizeName(name) {
  const bare = String(name ?? "").replace(/^@[^/]+\//, "");
  return bare
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** A plugin's display name: its package.json displayName (or pi.displayName), else its name, humanized. */
export function pluginName(baseDir, extensionPath = null) {
  const dir = baseDir ?? (extensionPath ? dirname(extensionPath) : null);
  const pkg = dir ? readJson(join(dir, "package.json"), null) : null;
  const shown = pkg?.displayName ?? pkg?.pi?.displayName;
  if (typeof shown === "string" && shown.trim()) return shown.trim();
  return humanizeName(pkg?.name ?? (dir ? basename(dir) : "a provider plugin")) || "A provider plugin";
}

/** Runs the probe. -> {registrations:[{provider, extensionPath, baseDir}], errors} (never throws). */
// Well under the daemon's 30 s plugin RPC timeout: a slow probe must not fail the phone's sign-in list.
export const PROBE_TIMEOUT_MS = 8_000;

export function probeProviderRegistrations(L, { timeoutMs = PROBE_TIMEOUT_MS, node = null } = {}) {
  const piDir = join(L.app, "pi");
  const bin = node ?? (existsSync(L.node) ? L.node : process.execPath);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(bin, [PROBE, piDir, L.root], {
        env: { ...process.env, PI_CODING_AGENT_DIR: L.piAgentDir },
        cwd: L.root && existsSync(L.root) ? L.root : undefined,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (e) {
      return finish({ registrations: [], errors: [String(e.message)] });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ registrations: [], errors: ["provider probe timed out"] });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => finish({ registrations: [], errors: [String(e.message)] }));
    child.on("close", () => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        const r = JSON.parse(line);
        finish({ registrations: Array.isArray(r.registrations) ? r.registrations : [], errors: r.errors ?? [] });
      } catch {
        finish({ registrations: [], errors: ["provider probe gave no answer"] });
      }
    });
  });
}

/** What the cached answer depends on: DinoBot's pi settings (pi install/remove/update rewrite it). */
function fingerprint(L) {
  try {
    const s = statSync(join(L.piAgentDir, "settings.json"));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "none";
  }
}

const cache = new Map();

/** The last good answer on disk, so the bots plugin (another process) starts warm after `provider add`. */
function cacheFile(L) {
  return join(L.root ?? L.piAgentDir, "state", "provider-overrides.json");
}
function readCacheFile(L, key) {
  try {
    const c = JSON.parse(readFileSync(cacheFile(L), "utf8"));
    return c?.key === key && Array.isArray(c.result) ? c.result : null;
  } catch {
    return null;
  }
}
function writeCacheFile(L, key, result) {
  try {
    const f = cacheFile(L);
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(`${f}.tmp`, `${JSON.stringify({ key, result })}\n`, { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  } catch {}
}

/**
 * The providers that added plugins register: [{provider, plugin, extensionPath}], one per provider
 * id (the last registration, which is the one pi uses). For an id pi already has ("anthropic"),
 * that plugin replaces pi's own provider. [] when the probe fails, so a broken plugin falls back to
 * the plain wording. A good answer is cached (memory, and state/provider-overrides.json, written
 * by `provider add|update|remove` too) until DinoBot's pi settings change; a failed or timed-out
 * probe is not cached, so the next call asks pi again.
 */
export async function providerOverrides(L, { probe = probeProviderRegistrations, fresh = false } = {}) {
  const key = `${L.piAgentDir}|${fingerprint(L)}`;
  if (!fresh && cache.has(key)) return cache.get(key);
  // No settings file: nothing was added (pi install writes it), so skip starting pi.
  if (key.endsWith("|none")) return [];
  if (!fresh) {
    const saved = readCacheFile(L, key);
    if (saved) {
      cache.set(key, saved);
      return saved;
    }
  }
  const { registrations, errors = [] } = await probe(L);
  const byProvider = new Map();
  for (const r of registrations) {
    if (!r?.provider) continue;
    byProvider.set(r.provider, { provider: r.provider, plugin: pluginName(r.baseDir, r.extensionPath), extensionPath: r.extensionPath });
  }
  const result = [...byProvider.values()];
  // Nothing found and something went wrong (timeout, no answer, a plugin that failed to load):
  // answer plainly now, but ask pi again next time.
  if (!registrations.length && errors.length) return result;
  for (const k of cache.keys()) if (k.startsWith(`${L.piAgentDir}|`)) cache.delete(k);
  cache.set(key, result);
  writeCacheFile(L, key, result);
  return result;
}
