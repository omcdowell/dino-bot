// Push notifications and Live Activities: the optional paseo-apns add-on (plugin id "apns").
//
// The tarball ships it in app/apns, but a stock install never registers it, so the daemon does not
// load it and nothing changes. It is for people who build the iPhone app themselves with their own
// Apple developer account: Apple only accepts pushes signed with a key of the team that signed the
// app (docs/live-activities.md). `dinobot push enable` turns it on:
//
//   dinobot push enable --key-path /path/to/AuthKey_<KEY_ID>.p8 --key-id <KEY_ID> --team-id <TEAM_ID> --topic <bundle id>
//   dinobot push enable --local     no key: the Live Activity only updates while the app is open
//   dinobot push disable | status | test
//
// Its state (config.json, notify-token, devices.json, push-log.jsonl) lives in ~/.dinobot/apns
// (PASEO_APNS_DIR in daemon.env), never ~/.config/paseo-apns, so a Paseo of your own is untouched.
// The .p8 key is named by path only: nothing here opens or reads it.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "./config.mjs";
import { PRODUCT, PRODUCT_ID, readJson, writeFileAtomic, writeJson } from "./util.mjs";

export const APNS_PLUGIN_ID = "apns";
export const DEFAULT_APNS_PORT = 6790;
/** Where the add-on keeps its files for this install. */
export const apnsDir = (L) => join(L.root, "apns");
/** The add-on's code in the unpacked tarball. */
export const apnsPluginDir = (L) => join(L.app, "apns");

// Same checks as the add-on's own config loader (addons/paseo-apns/server/config.ts).
const ID_RE = /^[A-Z0-9]{10}$/;
const TOPIC_RE = /^[A-Za-z0-9.-]{1,155}$/;

/** Validated add-on config for `enable`, or throws with what to fix. Never touches the key file. */
export function pushConfig({ local = false, keyPath, keyId, teamId, topic, port } = {}, { exists = existsSync, stat = statSync } = {}) {
  const p = port === undefined || port === true ? DEFAULT_APNS_PORT : Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error("--port must be a number from 1024 to 65535");
  const rate = { windowSeconds: 600, perSender: true }; // one alert per 10 minutes per bot
  if (local) return { mode: "local", port: p, rateLimit: rate };
  const missing = [["--key-path", keyPath], ["--key-id", keyId], ["--team-id", teamId], ["--topic", topic]].filter(([, v]) => typeof v !== "string" || !v);
  if (missing.length) throw new Error(`missing ${missing.map(([k]) => k).join(", ")} (or use --local for no remote push; see docs/live-activities.md)`);
  if (!keyPath.startsWith("/")) throw new Error("--key-path must be an absolute path to your .p8 key");
  if (!exists(keyPath) || !stat(keyPath).isFile()) throw new Error(`no key file at ${keyPath}`);
  if (!ID_RE.test(keyId)) throw new Error("--key-id must be the 10-character key ID from Apple (Keys page)");
  if (!ID_RE.test(teamId)) throw new Error("--team-id must be your 10-character Apple Team ID");
  if (!TOPIC_RE.test(topic)) throw new Error("--topic must be your app's bundle id, e.g. com.example.dinobot");
  if (/^com\.example\./i.test(topic)) throw new Error(`--topic ${topic} is the placeholder: use the bundle id you built the app with (PASEO_BUNDLE_ID)`);
  return { mode: "apns", keyPath, keyId, teamId, topic, port: p, rateLimit: rate, jwtReuseMinutes: 40 };
}

/** The daemon's config.json (in DinoBot's own PASEO_HOME). */
const daemonConfigPath = (L) => join(L.paseoHome, "config.json");

/**
 * Turns the add-on on: its config (600) and notify token (600) in ~/.dinobot/apns, the plugin
 * registered in the daemon config, PASEO_APNS_DIR in daemon.env. The daemon must restart after.
 */
export function enablePush(L, opts, deps) {
  if (!existsSync(join(apnsPluginDir(L), "paseo-plugin.json"))) {
    throw new Error(`this install has no push add-on (${apnsPluginDir(L)}); update first: ${PRODUCT_ID} update`);
  }
  const config = pushConfig(opts, deps);
  const dir = apnsDir(L);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeJson(join(dir, "config.json"), config, 0o600);
  const tokenPath = join(dir, "notify-token");
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(tokenPath, 0o600);

  const cfgPath = daemonConfigPath(L);
  const cfg = readJson(cfgPath, {}) ?? {};
  cfg.pluginsEnabled = true;
  cfg.plugins = { ...(cfg.plugins ?? {}), [APNS_PLUGIN_ID]: { source: "directory", path: apnsPluginDir(L), enabled: true } };
  mkdirSync(L.paseoHome, { recursive: true, mode: 0o700 });
  writeJson(cfgPath, cfg, 0o600);

  setEnvVar(L.envFile, "PASEO_APNS_DIR", dir);
  return { config, dir, keyMode: config.keyPath ? keyFileMode(config.keyPath) : null };
}

/** Turns the add-on off (plugin disabled in the daemon config). Its files stay, so `enable` can come back. */
export function disablePush(L) {
  const cfgPath = daemonConfigPath(L);
  const cfg = readJson(cfgPath, null);
  const src = cfg?.plugins?.[APNS_PLUGIN_ID];
  if (!src) return { changed: false };
  cfg.plugins[APNS_PLUGIN_ID] = { ...src, enabled: false };
  writeJson(cfgPath, cfg, 0o600);
  return { changed: src.enabled !== false };
}

/** What the install has: bundled, registered, enabled, mode, topic, registered phones. */
export function pushState(L) {
  const src = readJson(daemonConfigPath(L), {})?.plugins?.[APNS_PLUGIN_ID] ?? null;
  const dir = readEnvFile(L.envFile).PASEO_APNS_DIR || apnsDir(L);
  const config = readJson(join(dir, "config.json"), null);
  const devices = readJson(join(dir, "devices.json"), null);
  const list = Array.isArray(devices) ? devices : Array.isArray(devices?.devices) ? devices.devices : [];
  return {
    bundled: existsSync(join(apnsPluginDir(L), "paseo-plugin.json")),
    enabled: Boolean(src && src.enabled !== false),
    registered: Boolean(src),
    dir,
    mode: config ? (config.mode ?? "apns") : null,
    topic: config?.topic ?? null,
    port: config?.port ?? DEFAULT_APNS_PORT,
    phones: list.length,
  };
}

/** The add-on's local endpoint: GET /status, or POST /notify with a test alert. */
export async function pushEndpoint(L, { test = false, fetchImpl = fetch } = {}) {
  const st = pushState(L);
  let token;
  try {
    token = readFileSync(join(st.dir, "notify-token"), "utf8").trim();
  } catch {
    return { ok: false, message: `push is not set up (no notify token); run: ${PRODUCT_ID} push enable` };
  }
  const url = `http://127.0.0.1:${st.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const r = test
      ? await fetchImpl(`${url}/notify`, { method: "POST", headers, body: JSON.stringify({ sender: PRODUCT_ID, title: PRODUCT, body: "Test push: notifications work." }), signal: AbortSignal.timeout(15_000) })
      : await fetchImpl(`${url}/status`, { headers, signal: AbortSignal.timeout(5_000) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, message: `the push add-on does not answer on ${url} (${e.cause?.code ?? e.name}); is it enabled and the daemon restarted?` };
  }
}

function keyFileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** Sets one KEY=value in an env file (mode 600), keeping every other line. */
export function setEnvVar(path, key, value) {
  let lines = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  } catch {}
  const out = lines.filter((l) => !l.startsWith(`${key}=`));
  out.push(`${key}=${value}`);
  writeFileAtomic(path, `${out.join("\n")}\n`, 0o600);
}
