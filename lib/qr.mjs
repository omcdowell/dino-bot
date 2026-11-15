// The pairing QR, in the terminal and as a picture.
//
// Terminal: two modules per text cell (half blocks), 256-colour black (16) and white (231), not
// ANSI 47/30, which many themes draw as grey on grey. Terminals with extra line spacing (e.g. macOS
// Terminal) leave a strip of the cell background above or below block glyphs; the old rendering
// drew every dark module as a glyph, so light stripes ran through the whole code and phones could
// not read it. Here each cell's background is a real module colour: a cell whose two modules
// match is a plain space (no glyph, no gap), and a mixed cell puts its background on the side
// whose neighbour has the same colour, so a gap there merges into that module.
//
// Picture: a PNG (pure black on white, quiet zone 4) in the private DinoBot dir, mode 0600 (it
// holds the password, like the code). Opened on a Mac; elsewhere its path is printed.
//
// The picture never outlives QR_PNG_TTL_MS (10 minutes), whatever happens to setup,
// in layers: (1) the wizard deletes it when the phone is signed in, at its 10-minute wait's end, on
// an error and on Ctrl-C / SIGTERM / SIGHUP (guardQrPng); (2) a detached reaper started with the
// picture (lib/qr-reaper.mjs, own session: survives the terminal closing and the wizard being
// killed) deletes it at write + 10 min if it is still the same file; (3) the daemon (a service:
// back after a reboot) deletes any older than 10 min at start and every minute (startQrSweep, via
// the bots plugin), and `doctor` does too (sweepStaleQrPng).
import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./util.mjs";

export const QR_MARGIN = 4;
const BLACK = 16;
const WHITE = 231;
const RESET = "\u001b[0m";

/** The qrcode package the daemon ships (resolved from @getpaseo/server, like pairing-qr.js). */
export function loadQrcode(app) {
  const req = createRequire(join(app, "daemon", "node_modules", "@getpaseo", "server", "package.json"));
  return req("qrcode");
}

/**
 * Module matrix -> terminal text. `dark(r, c)` is true for a dark module; size = modules per side.
 * Returns the lines (each ends with a colour reset) and the columns used.
 */
export function renderModules(size, dark, margin = QR_MARGIN) {
  const at = (r, c) => r >= 0 && r < size && c >= 0 && c < size && Boolean(dark(r, c));
  const colour = (d) => (d ? BLACK : WHITE);
  const lines = [];
  for (let r = -margin; r < size + margin; r += 2) {
    let line = "";
    let prev = "";
    for (let c = -margin; c < size + margin; c++) {
      const top = at(r, c);
      const bottom = at(r + 1, c);
      let cell;
      if (top === bottom) cell = { sgr: `48;5;${colour(top)}`, ch: " " };
      else {
        // Background = bottom module if the module above this cell matches it (a gap at either
        // edge then sits next to that colour), else top if the module below matches top.
        const upper = at(r - 1, c) === bottom || at(r + 2, c) !== top;
        cell = upper
          ? { sgr: `38;5;${colour(top)};48;5;${colour(bottom)}`, ch: "▀" }
          : { sgr: `38;5;${colour(bottom)};48;5;${colour(top)}`, ch: "▄" };
      }
      if (cell.sgr !== prev) line += `\u001b[${cell.sgr}m`;
      prev = cell.sgr;
      line += cell.ch;
    }
    lines.push(`${line}${RESET}`);
  }
  return { lines, columns: size + 2 * margin };
}

/** The pairing link as terminal text (error correction M, as before: same code size, same app). */
export function renderTerminalQr(qrcode, url, { ec = "M" } = {}) {
  const qr = qrcode.create(url, { errorCorrectionLevel: ec });
  const { size } = qr.modules;
  return renderModules(size, (r, c) => qr.modules.get(r, c) === 1);
}

export function qrPngPath(L) {
  return join(L.root, "pairing-qr.png");
}

export const QR_PNG_TTL_MS = 10 * 60_000;

/** The picture's lifetime; DINOBOT_QR_TTL_MS only shortens it (tests). */
export function qrTtlMs(env = process.env) {
  const n = Number(env.DINOBOT_QR_TTL_MS);
  return Number.isFinite(n) && n > 0 && n < QR_PNG_TTL_MS ? n : QR_PNG_TTL_MS;
}

/**
 * Layer 2: a detached reaper (own session, no stdio, unref'd) that removes `path` at its mtime +
 * ttl if it is still the same file (inode and mtime): a newer QR has its own reaper. Wall clock,
 * checked at least every 30 s, so a sleeping Mac still ends on time when it wakes. No sudo.
 * DINOBOT_QR_REAPER=0 turns it off (tests that write pictures). -> pid or null.
 */
export function startQrReaper(path, { env = process.env, spawnFn = spawn, pollMs = 30_000 } = {}) {
  if (env.DINOBOT_QR_REAPER === "0" || process.env.DINOBOT_QR_REAPER === "0") return null;
  try {
    const st = statSync(path);
    const deadline = Math.floor(st.mtimeMs) + qrTtlMs(env);
    const script = fileURLToPath(new URL("./qr-reaper.mjs", import.meta.url));
    const child = spawnFn(process.execPath, [script, path, String(st.ino), String(Math.floor(st.mtimeMs)), String(deadline), String(pollMs)], { detached: true, stdio: "ignore" });
    child.on?.("error", () => {});
    child.unref?.();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/** Removes `path` only if it is still that file (same inode and mtime). */
export function removeIfSameFile(path, ino, mtimeMs) {
  try {
    const st = statSync(path);
    if (String(st.ino) !== String(ino) || Math.floor(st.mtimeMs) !== Number(mtimeMs)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Layer 3: removes the picture if it is older than the ttl (daemon start/minute, doctor). */
export function sweepStaleQrPng(L, { env = process.env, now = Date.now() } = {}) {
  const path = qrPngPath(L);
  try {
    const ageMs = Math.max(0, now - statSync(path).mtimeMs);
    if (ageMs < qrTtlMs(env)) return { removed: false, present: true, ageMs };
    rmSync(path, { force: true });
    return { removed: true, present: false, ageMs };
  } catch {
    return { removed: false, present: false, ageMs: null };
  }
}

/** The daemon's sweep: now and every `intervalMs` (≤ 1 min), unref'd. -> stop(). */
export function startQrSweep(L, { env = process.env, intervalMs = 60_000 } = {}) {
  const tick = () => {
    try {
      sweepStaleQrPng(L, { env });
    } catch {}
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
/**
 * Layer 1: while setup runs, Ctrl-C, SIGTERM and SIGHUP (terminal closed, SSH dropped) remove the
 * picture before the process ends. -> release().
 */
export function guardQrPng(L, { proc = process, exit = (code) => process.exit(code) } = {}) {
  const handlers = Object.entries(SIGNAL_CODES).map(([sig, code]) => {
    const h = () => {
      removeQrPng(L);
      exit(code);
    };
    proc.on(sig, h);
    return [sig, h];
  });
  return () => {
    for (const [sig, h] of handlers) proc.removeListener(sig, h);
  };
}

/**
 * Runs setup with the guard: a throw removes the picture too. A normal end keeps it (the user may
 * still be scanning it, e.g. `--yes` without the phone wait); its reaper removes it at 10 min.
 */
export async function withQrGuard(L, fn, opts = {}) {
  const release = guardQrPng(L, opts);
  try {
    return await fn();
  } catch (e) {
    removeQrPng(L);
    throw e;
  } finally {
    release();
  }
}

/** Writes the PNG (mode 0600, atomic) and starts its reaper. Big modules so a phone reads it off any screen. */
export async function writeQrPng(qrcode, L, url, { reap = startQrReaper } = {}) {
  const buf = await qrcode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: QR_MARGIN,
    scale: 10,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
  const path = qrPngPath(L);
  writeFileAtomic(path, buf, 0o600);
  reap(path);
  return path;
}

/** Removes the picture (after pairing, or a stale one from an earlier run). */
export function removeQrPng(L) {
  const path = qrPngPath(L);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * How to show the picture here: the command to open it, and the app's name, or null (print the
 * path). Mac: Preview via `open`. Linux/WSL only with a desktop, and never over SSH (it would open
 * on someone else's screen, or nowhere).
 */
export function pictureOpener({ platform = process.platform, env = process.env, wsl = null, has = () => false } = {}) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.DINOBOT_NO_OPEN) return null;
  if (platform === "darwin") return { cmd: "open", app: "Preview" };
  if (platform !== "linux") return null;
  if (wsl && has("wslview")) return { cmd: "wslview", app: "Windows" };
  if ((env.DISPLAY || env.WAYLAND_DISPLAY) && has("xdg-open")) return { cmd: "xdg-open", app: "your image viewer" };
  return null;
}

function onPath(bin, env = process.env) {
  return (env.PATH || "").split(":").some((d) => d && existsSync(join(d, bin)));
}

/**
 * Terminal QR + PNG + the "Can't scan?" line. `open` false (tests, --yes, not a terminal) only
 * writes the file. Returns { text, path, opened }.
 */
export async function showPairingQr(L, url, { qrcode = loadQrcode(L.app), open = true, wsl = null, env = process.env, platform = process.platform, launch = launchDetached, reap = (p) => startQrReaper(p, { env }) } = {}) {
  const { lines } = renderTerminalQr(qrcode, url);
  let path = null;
  let opened = null;
  try {
    path = await writeQrPng(qrcode, L, url, { reap });
    const opener = open ? pictureOpener({ platform, env, wsl, has: (b) => onPath(b, env) }) : null;
    if (opener && launch(opener.cmd, [path])) opened = opener.app;
  } catch {
    path = null; // the terminal code still works; no picture is not fatal
  }
  const hint = !path ? null : opened ? `Can't scan it? A picture of this code is open in ${opened} (${path}).` : `Can't scan it? A picture of this code is at ${path}`;
  // For the step-3 layout (tui.mjs): the same code at error correction L too (fewer modules: it
  // fits windows the M one does not). The picture stays M.
  const variants = [lines, renderTerminalQr(qrcode, url, { ec: "L" }).lines];
  return { text: lines.join("\n"), hint, path, opened, variants };
}

function launchDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
