// Saved install settings: ~/.config/dinobot/install.env (mode 600), outside ~/.dinobot so they
// survive a plain `dinobot uninstall` and a reinstall (shared Mac: the safety stop came back after
// every uninstall, because these lived only in ~/.dinobot/bin/*). Only `uninstall --purge` deletes it.
//
//   DINOBOT_TAILNET_ADDRESS   the Tailscale address to listen on (IP[,name]), shared-Mac route A
//   DINOBOT_TAILSCALE_BIN     your own Tailscale CLI, shared-Mac route B
//   DINOBOT_TAILSCALE_SOCKET  its tailscaled socket (route B)
//   DINOBOT_PORT              the port (the one the Mac's owner allowed you)
//
// Every `dinobot` command reads it (the environment wins over the file); setup and update save
// what the environment says (an older install's wrapper exports are moved here that way).
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEnvFile } from "./config.mjs";
import { PRODUCT_ID, writeFileAtomic } from "./util.mjs";

export const SAVED_KEYS = ["DINOBOT_TAILNET_ADDRESS", "DINOBOT_TAILSCALE_BIN", "DINOBOT_TAILSCALE_SOCKET", "DINOBOT_PORT"];

export const installEnvPath = (home) => join(home, ".config", PRODUCT_ID, "install.env");

/** The saved settings ({KEY: value}, only SAVED_KEYS). */
export function readInstallEnv(path) {
  const all = readEnvFile(path);
  return Object.fromEntries(SAVED_KEYS.filter((k) => all[k]).map((k) => [k, all[k]]));
}

/** Fills `env` with saved settings it does not have. -> {path, used: [keys taken from the file]} */
export function loadInstallEnv(env, path) {
  const saved = readInstallEnv(path);
  const used = [];
  for (const [k, v] of Object.entries(saved)) {
    if (env[k]) continue;
    env[k] = v;
    used.push(k);
  }
  return { path, used };
}

/** Saves the SAVED_KEYS set in `env` (others in the file are kept). Writes only on a change. -> keys saved, or []. */
export function saveInstallEnv(env, path) {
  const saved = readInstallEnv(path);
  const next = { ...saved };
  for (const k of SAVED_KEYS) if (env[k]) next[k] = String(env[k]).replace(/[\r\n]/g, "");
  if (SAVED_KEYS.every((k) => next[k] === saved[k])) return [];
  const text = SAVED_KEYS.filter((k) => next[k]).map((k) => `${k}=${next[k]}\n`).join("");
  writeFileAtomic(path, `# ${PRODUCT_ID} install settings (kept by uninstall; deleted by uninstall --purge)\n${text}`, 0o600);
  return SAVED_KEYS.filter((k) => next[k] !== saved[k]);
}

/** `uninstall --purge`: the file, and its folder when nothing else is in it. -> the path, or null. */
export function removeInstallEnv(path) {
  if (!existsSync(path)) return null;
  rmSync(path, { force: true });
  try {
    if (!readdirSync(dirname(path)).length) rmdirSync(dirname(path));
  } catch {}
  return path;
}
