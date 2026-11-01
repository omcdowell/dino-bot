// The separate herdr server for bot workers, and a portable stale-worker GC (a Node port of
// the dev host's herdr-gc-stale: no python3, works per session).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_ID, run, withoutHerdrPaneVars } from "./util.mjs";

// ---------------------------------------------------------------- short sockets
// herdr 0.9 puts a named session's sockets in <config>/herdr/sessions/<name>/herdr{,-client}.sock
// (<config> = $XDG_CONFIG_HOME or ~/.config, on macOS too). A unix socket path must fit sun_path
// (108 bytes on Linux, 104 on macOS, including the NUL), so a HOME longer than ~56 characters
// broke `herdr server`. herdr honours HERDR_SOCKET_PATH and HERDR_CLIENT_SOCKET_PATH, so for long
// paths we point both at a short private directory; the ~/.<id>/bin/herdr wrapper sets them.
export const SUN_PATH_MAX = { linux: 108, darwin: 104 };
const LONGEST_SOCKET = "herdr-client.sock";

export function defaultHerdrSessionDir(home, session, env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "herdr", "sessions", session);
}

/** Fits when the path plus its NUL is within sun_path (bytes, not characters). */
export function socketPathFits(path, os = process.platform) {
  return Buffer.byteLength(path) + 1 <= (SUN_PATH_MAX[os] ?? 104);
}

/**
 * Short socket directory for `session`, or null when herdr's own path fits (normal HOMEs keep
 * herdr's usual layout, so `herdr session attach` works as documented).
 * Candidates: $XDG_RUNTIME_DIR (Linux, per-user tmpfs), the per-user temp dir (macOS
 * DARWIN_USER_TEMP_DIR; not swept like /tmp), then /tmp/<id>-<uid>. `force` (tests) always
 * picks a short directory.
 */
export function herdrSocketDir({ home, session, env = process.env, os = process.platform, uid = process.getuid?.() ?? 0, darwinTemp, force = false }) {
  const def = join(defaultHerdrSessionDir(home, session, env), LONGEST_SOCKET);
  if (!force && socketPathFits(def, os)) return null;
  const leaf = `${PRODUCT_ID}-herdr-${session}`;
  const bases = [];
  if (os === "linux" && env.XDG_RUNTIME_DIR) bases.push(env.XDG_RUNTIME_DIR);
  if (os === "darwin") {
    let t = darwinTemp;
    if (t === undefined) {
      try {
        t = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
      } catch {
        t = "";
      }
    }
    if (t) bases.push(t.replace(/\/$/, ""));
  }
  bases.push(join("/tmp", `${PRODUCT_ID}-${uid}`));
  for (const base of bases) {
    const dir = join(base, leaf);
    if (socketPathFits(join(dir, LONGEST_SOCKET), os)) return dir;
  }
  return join("/tmp", `${PRODUCT_ID}-${uid}-h`); // always fits
}

export function socketEnv(dir) {
  return dir ? { HERDR_SOCKET_PATH: join(dir, "herdr.sock"), HERDR_CLIENT_SOCKET_PATH: join(dir, "herdr-client.sock") } : {};
}

/**
 * ~/.<id>/bin/herdr. Without a short socket dir: a plain exec of the bundled herdr. With one:
 * for our session (HERDR_SESSION=<session> and no HERDR_SOCKET_PATH yet, or the socket already
 * ours) it sets both socket variables; `session list` is patched so the bots plugin, which reads
 * socket_path and running from it, sees the real socket.
 */
export function herdrWrapper({ realBin, node, listScript, session, socketDir }) {
  if (!socketDir) return `#!/bin/sh\nexec "${realBin}" "$@"\n`;
  const sock = join(socketDir, "herdr.sock");
  return `#!/bin/sh
# Short herdr sockets: the default path under this HOME is too long for a unix socket.
D="${socketDir}"
if { [ "\${HERDR_SESSION:-}" = "${session}" ] && [ -z "\${HERDR_SOCKET_PATH:-}" ]; } || [ "\${HERDR_SOCKET_PATH:-}" = "${sock}" ]; then
  if [ ! -d "$D" ]; then (umask 077; mkdir -p "$D") || exit 1; fi
  [ -O "$D" ] || { echo "herdr: $D is not owned by you; refusing" >&2; exit 1; }
  export HERDR_SOCKET_PATH="${sock}" HERDR_CLIENT_SOCKET_PATH="${join(socketDir, "herdr-client.sock")}"
  if [ "\${1:-}" = session ] && [ "\${2:-}" = list ]; then
    exec "${node}" "${listScript}" "${realBin}" "${session}" "$@"
  fi
fi
exec "${realBin}" "$@"
`;
}

/** Env for a herdr command aimed at `session`: pane vars stripped, both session vars set. */
export async function sessionEnv(herdrBin, session, base = process.env) {
  const env = { ...withoutHerdrPaneVars(base), HERDR_SESSION: session };
  const info = await sessionInfo(herdrBin, session, env);
  if (info?.socket_path) env.HERDR_SOCKET_PATH = info.socket_path;
  return env;
}

// HERDR_SESSION must be set: the ~/.<id>/bin/herdr wrapper only applies the short-socket patch
// to `session list` for our session (without it the wizard never saw herdr running on the Mac).
export async function sessionInfo(herdrBin, session, env = { ...withoutHerdrPaneVars(process.env), HERDR_SESSION: session }) {
  const r = await run(herdrBin, ["session", "list", "--json"], { env, timeout: 5000 });
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const list = parsed?.result?.sessions ?? parsed?.sessions ?? (Array.isArray(parsed) ? parsed : []);
    return list.find((s) => s.name === session) ?? null;
  } catch {
    return null;
  }
}

/** Waits until the session reports running (the service or detached process starts it). */
export async function waitForSession(herdrBin, session, timeoutMs = 8000) {
  // herdrBin is our wrapper, so `session list` and the socket env already account for short sockets.
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const info = await sessionInfo(herdrBin, session);
    if (info?.running) {
      // "running" can be stale; the API answering is the real check.
      const env = { ...withoutHerdrPaneVars(process.env), HERDR_SESSION: session, ...(info.socket_path ? { HERDR_SOCKET_PATH: info.socket_path } : {}) };
      const api = await run(herdrBin, ["agent", "list"], { env, timeout: 3000 });
      if (api.code === 0) return info;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const EPOCH_RE = /-(\d{10})$/;

/** Decide what to close: pure, so it is unit-tested. */
export function planGc(agents, { nowSec, ttlSec }) {
  const close = [];
  const keep = [];
  for (const a of agents) {
    const row = { name: a.name ?? "", status: a.agent_status ?? "", pane_id: a.pane_id, workspace_id: a.workspace_id };
    let age = null;
    const m = EPOCH_RE.exec(row.name);
    if (m) age = nowSec - Number(m[1]);
    else {
      const sess = a.agent_session?.value;
      if (sess && existsSync(sess)) age = nowSec - Math.floor(statSync(sess).mtimeMs / 1000);
    }
    if (age === null) keep.push({ ...row, action: "skip_no_age" });
    else if (a.focused) keep.push({ ...row, action: "skip_focused" });
    else if (age < ttlSec) keep.push({ ...row, action: "keep_young" });
    else close.push({ ...row, action: "close", age_hours: Math.round(age / 36) / 100 });
  }
  return { close, keep };
}

export async function herdrGc({ herdrBin, session, apply = false, ttlHours = 48, logDir }) {
  const env = await sessionEnv(herdrBin, session);
  const listed = await run(herdrBin, ["agent", "list"], { env, timeout: 10_000 });
  if (listed.code !== 0) return { ok: false, error: `herdr session ${session} not running` };
  const agents = JSON.parse(listed.stdout)?.result?.agents ?? [];
  const plan = planGc(agents, { nowSec: Math.floor(Date.now() / 1000), ttlSec: ttlHours * 3600 });
  if (apply) {
    for (const row of plan.close) {
      const r = await run(herdrBin, ["pane", "close", row.pane_id], { env });
      row.result = r.code === 0 ? "closed" : `fail: ${r.stderr.trim().slice(0, 200)}`;
      if (row.workspace_id) await run(herdrBin, ["workspace", "close", row.workspace_id], { env });
    }
  }
  const report = { stamp: new Date().toISOString(), session, apply, ttl_hours: ttlHours, agents: agents.length, ...plan };
  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, `herdr-gc-${session}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  return { ok: true, report };
}
