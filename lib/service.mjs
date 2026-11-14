// Start at login (default on, not asked): systemd user units with linger on Linux, launchd agents on
// macOS. Mode "none" (tests, containers) starts the same commands as detached processes instead.
//
// Units:
//   dinobot.service                 the daemon (`paseo daemon run`)
//   dinobot-herdr.service           a separate herdr server (HERDR_SESSION=paseo-bots) for workers
//   dinobot-herdr-gc@.service/timer templated stale-worker GC per herdr session (Bitzer: needs
//                                    HERDR_SESSION + HERDR_SOCKET_PATH; the gc script sets both)
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PI_ENV, probeHostFor, readEnvFile, servicePath, HERDR_SESSION } from "./config.mjs";
import { PRODUCT, PRODUCT_ID, run, spawnDetached, withoutHerdrPaneVars, writeFileAtomic, writeJson, readJson } from "./util.mjs";

/** In ~/.<id>: setup turned linger on (uninstall --purge turns it off again only then). */
export const LINGER_MARK = `linger-enabled-by-${PRODUCT_ID}`;

// launchd label prefix; DINOBOT_LAUNCHD_LABEL gives tests a unique one (never the real label).
export const LABEL = process.env.DINOBOT_LAUNCHD_LABEL || `app.${PRODUCT_ID}`;

export function serviceMode(platform, requested) {
  if (requested) return requested;
  if (platform.os === "darwin") return "launchd";
  // WSL: systemd as PID 1 is not enough; `systemctl --user` needs the user's instance (its bus),
  // which a distro without dbus-user-session never gets.
  if (platform.hasSystemd && platform.wsl && !platform.wsl.userBus) return "none";
  if (platform.hasSystemd) return "systemd";
  return "none";
}

/**
 * Env for `systemctl --user`: a command started by Windows (`wsl.exe --exec …`, the sign-in script
 * from `dinobot wsl-autostart`) has no login session, so XDG_RUNTIME_DIR and the bus address are
 * unset although the user's systemd runs (linger). Filled in from /run/user/<uid> when missing.
 */
export function systemdUserEnv(env = process.env, uid = process.getuid?.() ?? 1000, exists = existsSync) {
  const out = { ...env };
  const dir = `/run/user/${uid}`;
  if (!out.XDG_RUNTIME_DIR && exists(dir)) out.XDG_RUNTIME_DIR = dir;
  if (!out.DBUS_SESSION_BUS_ADDRESS && exists(`${dir}/bus`)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${dir}/bus`;
  return out;
}
const userctl = (args, opts = {}) => run("systemctl", ["--user", ...args], { env: systemdUserEnv(), ...opts });

// ------------------------------------------------------------------ systemd
export function systemdUnits(L, { session = HERDR_SESSION } = {}) {
  const path = servicePath(L, "linux");
  const herdrNote = "# HERDR_* pane variables are never inherited here (units start clean).";
  return {
    [`${PRODUCT_ID}.service`]: `[Unit]
Description=${PRODUCT} daemon (bots, chats and workers for the phone app)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=${L.envFile}
ExecStart=${join(L.bin, "paseo")} daemon run --home ${L.paseoHome}
Restart=always
RestartSec=5
TimeoutStopSec=30
OOMScoreAdjust=-100

[Install]
WantedBy=default.target
`,
    [`${PRODUCT_ID}-herdr.service`]: `[Unit]
Description=${PRODUCT} herdr server for bot workers (session ${session})
${herdrNote}

[Service]
Type=simple
Environment=HOME=${L.home}
Environment=PATH=${path}
Environment=HERDR_SESSION=${session}
Environment=PI_CODING_AGENT_DIR=${L.piAgentDir}
${Object.entries(PI_ENV).map(([k, v]) => `Environment=${k}=${v}`).join("\n")}
ExecStart=${join(L.bin, "herdr")} server
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
    [`${PRODUCT_ID}-herdr-gc@.service`]: `[Unit]
Description=Close ${PRODUCT} herdr workers older than 48h (session %i)

[Service]
Type=oneshot
Environment=HOME=${L.home}
Environment=PATH=${path}
Environment=HERDR_SESSION=%i
ExecStart=${join(L.bin, PRODUCT_ID)} herdr-gc --session %i --apply --ttl-hours 48
SuccessExitStatus=0 1
`,
    [`${PRODUCT_ID}-herdr-gc@.timer`]: `[Unit]
Description=Daily ${PRODUCT} herdr worker GC (session %i)

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

function systemdDir(L) {
  return join(L.home, ".config", "systemd", "user");
}

// ------------------------------------------------------------------ launchd
function plist(label, args, env, extra = "") {
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${k}</key><string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
${extra}  </dict>
</plist>
`;
}
function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdAgents(L, { session = HERDR_SESSION } = {}) {
  const env = readEnvFile(L.envFile);
  const path = servicePath(L, "darwin");
  const keep = `    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key><true/>\n`;
  const log = (name) => `    <key>StandardOutPath</key><string>${join(L.logs, name)}</string>\n    <key>StandardErrorPath</key><string>${join(L.logs, name)}</string>\n`;
  return {
    [`${LABEL}.daemon.plist`]: plist(`${LABEL}.daemon`, [join(L.bin, "paseo"), "daemon", "run", "--home", L.paseoHome], env, keep + log("daemon.log")),
    [`${LABEL}.herdr.plist`]: plist(`${LABEL}.herdr`, [join(L.bin, "herdr"), "server"], { HOME: L.home, PATH: path, HERDR_SESSION: session, PI_CODING_AGENT_DIR: L.piAgentDir, ...PI_ENV }, keep + log("herdr.log")),
    [`${LABEL}.herdr-gc.plist`]: plist(
      `${LABEL}.herdr-gc`,
      [join(L.bin, PRODUCT_ID), "herdr-gc", "--session", session, "--apply", "--ttl-hours", "48"],
      { HOME: L.home, PATH: path, HERDR_SESSION: session },
      `    <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>49</integer></dict>\n` + log("herdr-gc.log"),
    ),
  };
}

// ------------------------------------------------------------------ install / start
/** Writes the service files for `mode`; returns their paths. */
export function writeServices(L, mode, opts = {}) {
  if (mode === "systemd") {
    const dir = systemdDir(L);
    mkdirSync(dir, { recursive: true });
    return Object.entries(systemdUnits(L, opts)).map(([name, text]) => {
      writeFileAtomic(join(dir, name), text, 0o644);
      return join(dir, name);
    });
  }
  if (mode === "launchd") {
    const dir = join(L.home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    mkdirSync(L.logs, { recursive: true });
    return Object.entries(launchdAgents(L, opts)).map(([name, text]) => {
      // 0600: the daemon agent carries PASEO_PASSWORD from daemon.env (rel-security L1).
      writeFileAtomic(join(dir, name), text, 0o600);
      return join(dir, name);
    });
  }
  return [];
}

/**
 * Starts (or restarts) everything. Returns notes for the summary (e.g. the linger command when it
 * needs privileges; we never sudo).
 */
/**
 * launchd: `bootout` returns while the job is still shutting down (SIGTERMed; the daemon's
 * graceful stop can take 20 s+), and a `bootstrap` in that window fails with "5: Input/output
 * error", which left `dinobot stop && dinobot start` (and every restart: update, setup) with
 * nothing running. So bootout waits until launchd has dropped the job, and bootstrap retries.
 */
export async function launchdBootout(uid, label, { timeoutMs = 45_000, exec = run, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  await exec("launchctl", ["bootout", `gui/${uid}/${label}`]);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await exec("launchctl", ["print", `gui/${uid}/${label}`])).code !== 0) return true;
    await sleep(500);
  }
  return false;
}

export async function launchdBootstrap(uid, label, plist, { timeoutMs = 45_000, exec = run, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await exec("launchctl", ["bootstrap", `gui/${uid}`, plist]);
    if (r.code === 0) return true;
    if (/already|service already loaded|17:/i.test(r.stderr)) {
      await exec("launchctl", ["kickstart", `gui/${uid}/${label}`]); // loaded: make sure it runs
      return true;
    }
    if (Date.now() >= end) {
      await exec("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
      return false;
    }
    await sleep(1000); // "5: Input/output error": the previous instance is still stopping
  }
}

export async function startServices(L, mode, { herdr = true, session = HERDR_SESSION, restart = false } = {}) {
  const notes = [];
  if (mode === "systemd") {
    await userctl(["daemon-reload"]);
    const verb = restart ? "restart" : "start";
    await userctl(["enable", `${PRODUCT_ID}.service`]);
    const r = await userctl([verb, `${PRODUCT_ID}.service`], { timeout: 30_000 });
    if (r.code !== 0) throw new Error(`systemctl --user ${verb} ${PRODUCT_ID}.service failed: ${r.stderr.trim()}`);
    if (herdr) {
      await userctl(["enable", "--now", `${PRODUCT_ID}-herdr.service`]);
      await userctl(["enable", "--now", `${PRODUCT_ID}-herdr-gc@${session}.timer`]);
    }
    const user = process.env.USER ?? "";
    const linger = await run("loginctl", ["show-user", user, "--property=Linger"]);
    if (!/Linger=yes/.test(linger.stdout)) {
      const en = await run("loginctl", ["enable-linger", user]);
      // Remembered so `uninstall --purge` turns linger off only when it was ours to turn on.
      if (en.code === 0) writeFileAtomic(join(L.root, LINGER_MARK), `${new Date().toISOString()}\n`, 0o644);
      if (en.code !== 0) notes.push(`To keep your bots running after you log out, run once:  sudo loginctl enable-linger ${user}`);
    }
    return notes;
  }
  if (mode === "launchd") {
    const uid = process.getuid?.() ?? 501;
    const dir = join(L.home, "Library", "LaunchAgents");
    const labels = [`${LABEL}.daemon`, ...(herdr ? [`${LABEL}.herdr`, `${LABEL}.herdr-gc`] : [])];
    for (const label of labels) {
      if (restart) await launchdBootout(uid, label);
      await launchdBootstrap(uid, label, join(dir, `${label}.plist`));
    }
    return notes;
  }
  // none: detached processes, pids remembered for `dinobot stop`.
  if (restart) {
    await stopServices(L, "none", { only: herdr ? null : "daemon" });
    const listen = readEnvFile(L.envFile).PASEO_LISTEN ?? "";
    const port = Number(/:(\d+)$/.exec(listen)?.[1]);
    if (port) await waitForClosed(port, 10_000, probeHostFor(listen));
  }
  const pids = readJson(join(L.root, "pids.json"), {}) ?? {};
  // `dinobot start` while it already runs: keep it. A second daemon would lose the port race and
  // pids.json would then point at the dead one, so `dinobot stop` could no longer stop the first.
  if (!restart && groupAlive(pids.daemon)) {
    notes.push(`${PRODUCT} is already running (pid ${pids.daemon}).`);
    return notes;
  }
  const env = { ...withoutHerdrPaneVars(process.env), ...readEnvFile(L.envFile) };
  pids.daemon = spawnDetached(join(L.bin, "paseo"), ["daemon", "run", "--home", L.paseoHome], { env, cwd: L.home, log: join(L.logs, "daemon.log") });
  if (herdr && existsSync(join(L.bin, "herdr")) && !restart) {
    pids.herdr = spawnDetached(join(L.bin, "herdr"), ["server"], {
      env: { ...withoutHerdrPaneVars(process.env), PATH: servicePath(L), HERDR_SESSION: session, PI_CODING_AGENT_DIR: L.piAgentDir, ...PI_ENV },
      cwd: L.home,
      log: join(L.logs, "herdr.log"),
    });
  }
  writeJson(join(L.root, "pids.json"), pids);
  notes.push(noServiceNote(L));
  return notes;
}

function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The summary line when nothing (systemd/launchd) restarts the daemon. `dinobot` is not on PATH. */
export function noServiceNote(L) {
  return `Started without a service manager (no systemd), so nothing starts it again after a reboot: then run \`${join(L.bin, PRODUCT_ID)} start\`.`;
}

export async function stopServices(L, mode, { only = null } = {}) {
  if (mode === "systemd") {
    await userctl(["stop", `${PRODUCT_ID}.service`, `${PRODUCT_ID}-herdr.service`], { timeout: 30_000 });
    return;
  }
  if (mode === "launchd") {
    const uid = process.getuid?.() ?? 501;
    for (const l of ["daemon", "herdr", "herdr-gc"]) await launchdBootout(uid, `${LABEL}.${l}`);
    return;
  }
  const pids = readJson(join(L.root, "pids.json"), {}) ?? {};
  const stopping = [];
  for (const [name, pid] of Object.entries(pids)) {
    if (only && name !== only) continue;
    try {
      process.kill(-pid, "SIGTERM"); // the detached process group
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    stopping.push(pid);
    delete pids[name];
  }
  writeJson(join(L.root, "pids.json"), pids);
  // A graceful daemon shutdown can take >20 s; wait up to 30 s, then SIGKILL the group, so a
  // restart never races the old process for the port (seen once in an update e2e).
  const alive = (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const end = Date.now() + 30_000;
  while (stopping.some(alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  for (const pid of stopping.filter(alive)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
}

export function removeServices(L, mode) {
  const files =
    mode === "systemd"
      ? Object.keys(systemdUnits(L)).map((n) => join(systemdDir(L), n))
      : mode === "launchd"
        ? Object.keys(launchdAgents(L)).map((n) => join(L.home, "Library", "LaunchAgents", n))
        : [];
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {}
  }
  return files;
}

/**
 * Uninstall: systemd units are disabled (and stopped) while their files still exist, then deleted,
 * then systemd forgets them. Deleting the files alone left dangling links in default.target.wants and
 * a GC timer still firing daily against a removed app (linux-ready, Ubuntu 24.04 with systemd).
 */
export async function uninstallServices(L, mode, { session = HERDR_SESSION, exec = run } = {}) {
  const units = [`${PRODUCT_ID}.service`, `${PRODUCT_ID}-herdr.service`, `${PRODUCT_ID}-herdr-gc@${session}.timer`];
  if (mode === "systemd") await exec("systemctl", ["--user", "disable", "--now", ...units], { timeout: 30_000 });
  const files = removeServices(L, mode);
  if (mode === "systemd") {
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "reset-failed", ...units, `${PRODUCT_ID}-herdr-gc@${session}.service`]);
  }
  return files;
}

async function canConnect(port, host = "127.0.0.1") {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

export async function waitForClosed(port, timeoutMs, host) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && (await canConnect(port, host))) await new Promise((r) => setTimeout(r, 200));
}

/** Waits until the daemon accepts TCP connections on host:port (TCP only; see ready.mjs for "ready"). */
export async function waitForListen(port, timeoutMs = 60_000, host = "127.0.0.1") {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await canConnect(port, host)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
