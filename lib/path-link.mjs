// `dinobot` on the user's PATH: ~/.local/bin/dinobot, a symlink to ~/.dinobot/bin/dinobot
// (owner decision, 14 Nov: a link in ~/.local/bin, no shell rc/profile edits). Only `dinobot`:
// paseo, herdr, pi and the git guard stay in ~/.dinobot/bin so the user's own tools are never
// shadowed. A ~/.local/bin/dinobot that is not our link is left alone (warned about).
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { PRODUCT, PRODUCT_ID } from "./util.mjs";

/** ~/.local/bin and the link in it. */
export function linkPaths(L) {
  const dir = join(L.home, ".local", "bin");
  return { dir, link: join(dir, PRODUCT_ID), target: join(L.bin, PRODUCT_ID) };
}

const inside = (p, root) => {
  const r = resolve(root);
  const x = resolve(p);
  return x === r || x.startsWith(r.endsWith(sep) ? r : r + sep);
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * What is at `link` now: "missing", "ours" (a symlink into this install's root, even if broken or
 * stale), or "foreign" (a file, folder, or a symlink to anything else). Never follows the link to
 * decide what to delete; the target is only read.
 */
export function linkState(L, link = linkPaths(L).link) {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return { kind: "missing" };
  }
  if (!st.isSymbolicLink()) return { kind: "foreign", what: st.isDirectory() ? "folder" : "file" };
  const to = readlinkSync(link);
  const abs = resolve(dirname(link), to);
  const rootReal = real(L.root);
  const ours = inside(abs, L.root) || (rootReal && inside(abs, rootReal)) || (real(abs) && rootReal && inside(real(abs), rootReal));
  return ours ? { kind: "ours", to } : { kind: "foreign", what: `link to ${to}` };
}

/** Whether `dir` is one of PATH's entries (as written, with ~ expanded, or by real path). */
export function dirOnPath(dir, env = process.env) {
  const want = [resolve(dir), real(dir)].filter(Boolean);
  for (const raw of String(env.PATH ?? "").split(delimiter)) {
    if (!raw) continue;
    const p = raw.startsWith("~/") && env.HOME ? join(env.HOME, raw.slice(2)) : raw;
    if (want.includes(resolve(p)) || (real(p) && want.includes(real(p)))) return true;
  }
  return false;
}

/** The shell rc a line goes into: zsh (macOS default) -> ~/.zshrc, bash (Linux default) -> ~/.bashrc. */
export function shellRc(env = process.env, os = process.platform) {
  const sh = basename(String(env.SHELL ?? ""));
  if (sh === "zsh") return "~/.zshrc";
  if (sh === "bash") return "~/.bashrc";
  if (sh === "fish") return null;
  return os === "darwin" ? "~/.zshrc" : "~/.bashrc";
}

/** The exact one line that puts ~/.local/bin on PATH for this shell (printed, never run). */
export function pathHint(env = process.env, os = process.platform) {
  const rc = shellRc(env, os);
  if (!rc) return "fish_add_path ~/.local/bin";
  return `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc}`;
}

/**
 * Makes ~/.local/bin/dinobot point at ~/.dinobot/bin/dinobot (setup, update). Idempotent: our
 * link is kept, or re-pointed when it is stale. Something else there: left as it is, warned.
 * DINOBOT_NO_PATH_LINK=1 skips it (test installs that share a HOME with a real one).
 * -> { status: created | kept | repaired | foreign | skipped | failed, link, target, dir,
 *      onPath, command, note (text for the user or null) }
 *   command: what to type for later commands: "dinobot" when that runs this install, else the
 *   full path.
 */
export function ensurePathLink(L, { env = process.env, os = process.platform } = {}) {
  const { dir, link, target } = linkPaths(L);
  const base = { link, target, dir, onPath: false, command: target, note: null };
  if (env.DINOBOT_NO_PATH_LINK === "1") return { ...base, status: "skipped" };
  let status;
  const now = linkState(L, link);
  try {
    if (now.kind === "foreign") {
      status = "foreign";
    } else if (now.kind === "ours" && resolve(dir, now.to) === resolve(target)) {
      status = "kept";
    } else {
      mkdirSync(dir, { recursive: true });
      if (now.kind === "ours") unlinkSync(link);
      symlinkSync(target, link);
      status = now.kind === "ours" ? "repaired" : "created";
    }
  } catch (e) {
    return { ...base, status: "failed", note: `Could not link ${link} -> ${target} (${e.message}). Run ${PRODUCT} as ${target}.` };
  }
  const onPath = status !== "foreign" && dirOnPath(dir, env);
  let note = null;
  if (status === "foreign") note = `${link} already exists (${now.what}) and is not ${PRODUCT}'s, so it was left as it is. Run ${PRODUCT} as ${target}.`;
  else if (!onPath) note = `\`${PRODUCT_ID}\` is linked in ~/.local/bin, which is not on your PATH yet. To type just \`${PRODUCT_ID}\`, run this one line (${PRODUCT} does not edit your shell files), then open a new terminal:\n    ${pathHint(env, os)}\n  Until then: ${target}`;
  return { ...base, status, onPath, command: onPath ? PRODUCT_ID : target, note };
}

/** What to print for later commands without changing anything: "dinobot" when our link is on PATH, else the full path. */
export function commandName(L, env = process.env) {
  const { dir, target } = linkPaths(L);
  return env.DINOBOT_NO_PATH_LINK !== "1" && linkState(L).kind === "ours" && dirOnPath(dir, env) ? PRODUCT_ID : target;
}

/** Uninstall: ~/.local/bin/dinobot if it is our symlink (into L.root). Never the folder. -> path or null. */
export function removePathLink(L) {
  const { link } = linkPaths(L);
  if (linkState(L, link).kind !== "ours") return null;
  try {
    unlinkSync(link);
    return link;
  } catch {
    return null;
  }
}
