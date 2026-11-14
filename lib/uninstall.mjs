// dinobot uninstall [--purge] [--yes]
//
//   uninstall          services stopped and removed (systemd units / launchd agents), herdr's short
//                      socket dir, and all of ~/.dinobot: the app, sign-ins (pi/auth.json), the daemon
//                      password and key. Kept: bots, memories, group chats, herdr's own dirs.
//   uninstall --purge  full wipe: the above plus ~/bots, ~/.optchat, ~/.local/state/bot-rooms,
//                      ~/.local/state/bot-dm, ~/.config/herdr, ~/.local/state/herdr. Shows the exact
//                      paths with sizes and asks for DELETE at a terminal (--yes skips the question;
//                      no terminal and no --yes: refused). Linger goes off only if setup turned it on.
//
// Guards: nothing that resolves to HOME, to `/` or to a folder above HOME is ever deleted, and
// symlinks are removed as links (never followed out of the listed paths).
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { HERDR_SESSION, readEnvFile } from "./config.mjs";
import { LINGER_MARK, serviceMode, stopServices, uninstallServices } from "./service.mjs";
import { detectWsl, wslAutostart } from "./wsl.mjs";
import { platform } from "./detect.mjs";
import { PRODUCT, PRODUCT_ID, readJson, run } from "./util.mjs";


/** Real path of `p`, or of its nearest existing parent with the rest joined back on. */
function realish(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(cur.slice(up.length).replace(/^[/\\]+/, ""));
      cur = up;
    }
  }
}

/**
 * Why `p` must not be deleted (null: fine). Refused: not absolute, `/`, HOME itself or a folder
 * that contains HOME, checked on the path as written and on its real location (parent symlinks
 * resolved; a symlink itself is removed as a link, so its target does not matter).
 */
export function unsafeReason(p, home) {
  if (!p || !isAbsolute(p)) return "not an absolute path";
  const h = [resolve(home), realish(home)];
  const lexical = resolve(p);
  let real = realish(dirname(lexical));
  real = join(real, lexical.slice(dirname(lexical).length).replace(/^[/\\]+/, ""));
  for (const x of [lexical, real]) {
    if (x === sep || x === resolve("/")) return "is /";
    for (const hh of h) {
      if (x === hh) return "is your home folder";
      if (hh.startsWith(x.endsWith(sep) ? x : x + sep)) return "contains your home folder";
    }
  }
  return null;
}

/** Bytes under `p` (lstat: symlinks count as themselves, never followed). */
export function diskSize(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  let names = [];
  try {
    names = readdirSync(p);
  } catch {}
  for (const name of names) n += diskSize(join(p, name));
  return n;
}

export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/**
 * What each mode deletes, in order. `daemonEnv` is ~/.dinobot/daemon.env (the bots folder the
 * daemon really used, when PASEO_BOTS_ROOT was set at setup and not now). Only existing paths
 * (or symlinks) are returned, each once.
 */
export function uninstallTargets(L, { purge = false, env = process.env, state = null, daemonEnv = {} } = {}) {
  // XDG dirs only when inside HOME: a test HOME (or DINOBOT_HOME install) run from a shell with
  // XDG_* pointing at the real account must not reach the real account's herdr or bot state.
  const inHome = (p) => (p && isAbsolute(p) && resolve(p).startsWith(resolve(L.home) + sep) ? p : null);
  const config = inHome(env.XDG_CONFIG_HOME) || join(L.home, ".config");
  const st = inHome(env.XDG_STATE_HOME) || join(L.home, ".local", "state");
  const list = [];
  if (state?.herdrSocketDir) list.push({ path: state.herdrSocketDir, what: "herdr sockets" });
  list.push({ path: L.root, what: `${PRODUCT} app, sign-ins, daemon password and key` });
  if (L.piAgentDir !== join(L.root, "pi")) list.push({ path: L.piAgentDir, what: "sign-ins (DINOBOT_PI_DIR)" });
  if (purge) {
    list.push({ path: L.botsRoot, what: "bots" });
    if (daemonEnv.PASEO_BOTS_ROOT && resolve(daemonEnv.PASEO_BOTS_ROOT) !== resolve(L.botsRoot)) list.push({ path: daemonEnv.PASEO_BOTS_ROOT, what: "bots" });
    list.push({ path: L.optchatHome, what: "memories (OptChat profiles)" });
    list.push({ path: inHome(env.PASEO_BOTS_ROOMS) || join(st, "bot-rooms"), what: "group chats" });
    list.push({ path: join(st, "bot-dm"), what: "bot messages and worker registry" });
    list.push({ path: join(config, "herdr"), what: "herdr config and sessions" });
    list.push({ path: join(st, "herdr"), what: "herdr state" });
  }
  const seen = new Set();
  return list.filter((t) => {
    const k = resolve(t.path);
    if (seen.has(k)) return false;
    seen.add(k);
    try {
      lstatSync(k);
      return true;
    } catch {
      return false;
    }
  });
}

/** Reads one line from `input` (a TTY in real use). */
function readLine(input, output, question) {
  return new Promise((done) => {
    const rl = createInterface({ input, output, terminal: false });
    output.write(question);
    let got = null;
    rl.once("line", (l) => {
      got = l;
      rl.close();
    });
    rl.once("close", () => done(got ?? ""));
  });
}

/** Deletes `p` without following symlinks (a symlink goes as a link). Returns an error text or null. */
export function removePath(p, home) {
  const why = unsafeReason(p, home);
  if (why) return `not deleted: ${p} ${why}`;
  try {
    rmSync(p, { recursive: true, force: true });
    return null;
  } catch (e) {
    return `could not delete ${p}: ${e.message}`;
  }
}

/**
 * Linger (systemd): off only when setup turned it on (the mark in ~/.dinobot). Otherwise, if it is
 * on, nobody knows who turned it on: print the command instead.
 */
async function lingerOff(L, { hadMark, exec, print, env }) {
  const user = env.USER || "";
  if (!user) return;
  const r = await exec("loginctl", ["show-user", user, "--property=Linger"]);
  if (!/Linger=yes/.test(r.stdout ?? "")) return;
  if (hadMark) {
    const off = await exec("loginctl", ["disable-linger", user]);
    if (off.code === 0) return print(`Linger turned off (${PRODUCT} setup had turned it on).`);
    return print(`Could not turn linger off. Run:  loginctl disable-linger ${user}`);
  }
  print(`Linger is on for ${user}; ${PRODUCT} cannot tell whether its setup turned it on. If nothing else needs it:  loginctl disable-linger ${user}`);
}

/**
 * The uninstall command. deps (tests): out, input, isTTY, exec, stop, removeServices, wsl, mode.
 * Returns { ok, removed, kept, refused }.
 */
export async function uninstall(L, args = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? process.stdout;
  const print = (s = "") => out.write(`${s}\n`);
  const exec = deps.exec ?? run;
  const purge = Boolean(args.purge);
  const state = readJson(L.state);
  const daemonEnv = readEnvFile(L.envFile);
  const hadMark = existsSync(join(L.root, LINGER_MARK));
  const targets = uninstallTargets(L, { purge, env, state, daemonEnv });
  const bad = targets.map((t) => ({ ...t, why: unsafeReason(t.path, L.home) })).filter((t) => t.why);
  if (bad.length) {
    for (const t of bad) print(`Refusing: ${t.path} ${t.why}.`);
    process.exitCode = 1;
    return { ok: false, refused: "unsafe", removed: [] };
  }

  if (purge) {
    print(`This deletes everything ${PRODUCT} made on this computer, for good:`);
    if (!targets.length) print("  (nothing found on disk)");
    for (const t of targets) print(`  ${humanSize(diskSize(t.path)).padStart(8)}  ${t.path}  (${t.what})`);
    print(`plus the ${PRODUCT} services (start at login).`);
    if (!args.yes) {
      const input = deps.input ?? process.stdin;
      const tty = deps.isTTY ?? Boolean(process.stdin.isTTY);
      if (!tty) {
        print(`Not deleted: no terminal to confirm. Run it in a terminal, or add --yes:  ${PRODUCT_ID} uninstall --purge --yes`);
        process.exitCode = 1;
        return { ok: false, refused: "no-tty", removed: [] };
      }
      const answer = (await readLine(input, out, "Type DELETE to delete all of this: ")).trim();
      if (answer !== "DELETE") {
        print("Not deleted (you did not type DELETE). Nothing was changed.");
        process.exitCode = 1;
        return { ok: false, refused: "not-confirmed", removed: [] };
      }
    }
  }

  const mode = deps.mode ?? state?.serviceMode ?? serviceMode(platform());
  await (deps.stop ?? stopServices)(L, mode).catch(() => {});
  await (deps.removeServices ?? uninstallServices)(L, mode, { session: state?.herdrSession ?? HERDR_SESSION }).catch(() => {});
  // WSL: the Windows Startup script and .wslconfig change from `dinobot wsl-autostart` would start
  // a removed DinoBot at every sign-in.
  const wsl = deps.wsl !== undefined ? deps.wsl : await detectWsl({ env }).catch(() => null);
  if (wsl) await (deps.wslAutostart ?? wslAutostart)(L, { off: true, env, say: print }).catch((e) => print(`Windows sign-in start not removed (${e.message}); run in Ubuntu before uninstalling, or delete the ${PRODUCT} script from your Windows Startup folder.`));

  const removed = [];
  const errors = [];
  for (const t of targets) {
    const err = removePath(t.path, L.home);
    if (err) errors.push(err);
    else removed.push(t.path);
  }
  for (const e of errors) print(e);
  if (purge && mode === "systemd") await lingerOff(L, { hadMark, exec, print, env });

  if (purge) {
    print(`${PRODUCT} is wiped from this computer: services, app, sign-ins, bots, memories and group chats.`);
  } else {
    print(`Removed the ${PRODUCT} services, the app and ~/.${PRODUCT_ID} (your sign-ins are removed too).`);
    print(`Your bots (${L.botsRoot}) and memories (${L.optchatHome}) are kept.`);
    const rest = uninstallTargets(L, { purge: true, env, daemonEnv }).map((t) => t.path);
    if (rest.length) print(`To delete those too (bots, memories, group chats, herdr), next time use \`${PRODUCT_ID} uninstall --purge\`, or now:  rm -rf ${rest.map((p) => JSON.stringify(p)).join(" ")}`);
  }
  if (errors.length) process.exitCode = 1;
  return { ok: !errors.length, removed, errors };
}
