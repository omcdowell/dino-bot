#!/usr/bin/env node
// Drop what never runs from every node_modules tree in a release stage (perf-install, 31 Oct:
// smaller download, faster unpack). Only inside node_modules; the top-level packages (daemon, pi,
// optchat, bots, installer) keep every file they ship.
//
//   node build/prune-stage.mjs STAGE [--dry-run]
//
// Removed:
//   *.map, *.d.ts/.d.mts/.d.cts          source maps and type declarations (never loaded by Node)
//   README*/CHANGELOG*/HISTORY* (package root) docs
//   <pkg>/src, test, tests, __tests__     only when nothing in the package points at them: not named
//                                         in package.json main/module/exports/imports/bin/browser/pi
//                                         (pi extensions), and no JS/TS file outside the folder
//                                         imports it by a relative path
// Kept on purpose: licence/notice/copying/authors files (licences of everything we ship), the
// `typescript` package (its lib .d.ts files are runtime data for the compiler), npm and node-gyp
// (node-gyp builds native addons from its src/ for pi's plugin installs), anything under a
// `skills` folder (pi skills are markdown loaded at runtime).
// Prints one summary line; --dry-run lists what would go and changes nothing.
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [stage, ...flags] = process.argv.slice(2);
if (!stage) {
  console.error("usage: prune-stage.mjs STAGE [--dry-run]");
  process.exit(2);
}
const DRY = flags.includes("--dry-run");

const FILE_RE = /\.(map|d\.ts|d\.mts|d\.cts)$/;
const DOC_RE = /^(readme|changelog|history)(\.|$)/i;
const KEEP_RE = /^(licen[cs]e|copying|notice|authors|patents|third[-_]party)/i;
const DIRS = ["src", "test", "tests", "__tests__"];
const KEEP_PKGS = new Set(["typescript", "npm", "node-gyp"]);

let files = 0;
let bytes = 0;
const dirsGone = [];

function size(p) {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) n += size(join(p, e));
  return n;
}
function drop(p) {
  const s = size(p);
  bytes += s;
  if (DRY) console.log(`would remove ${relative(stage, p)} (${s} B)`);
  else rmSync(p, { recursive: true, force: true });
}

/** All JS/TS source text in `dir` (not .d.ts), skipping `skip` (one child folder) and nested node_modules. */
function jsText(dir, skip) {
  let out = "";
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (p === skip || e.name === "node_modules") continue;
    if (e.isDirectory()) out += jsText(p, skip);
    else if (e.isFile() && /\.(c|m)?[jt]sx?$/.test(e.name) && !FILE_RE.test(e.name)) out += readFileSync(p, "utf8");
  }
  return out;
}

/** True when nothing in package `pkgDir` points at its child folder `name`. */
function unreferenced(pkgDir, pkgJson, name) {
  const { main, module, exports, imports, bin, browser, pi } = pkgJson;
  const entry = JSON.stringify({ main, module, exports, imports, bin, browser, pi });
  const re = new RegExp(`(^|["'/.])${name}(/|["'])`);
  if (re.test(entry)) return false;
  const ref = new RegExp(`(require\\(|from\\s*|import\\()\\s*["'](\\.\\.?/)+${name}/`);
  return !ref.test(jsText(pkgDir, join(pkgDir, name)));
}

function prunePackage(pkgDir) {
  let pj = null;
  try {
    pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return;
  }
  if (KEEP_PKGS.has(pj.name)) return;
  for (const name of DIRS) {
    const d = join(pkgDir, name);
    let st;
    try {
      st = lstatSync(d);
    } catch {
      continue;
    }
    if (st.isDirectory() && unreferenced(pkgDir, pj, name)) {
      drop(d);
      dirsGone.push(relative(stage, d));
    }
  }
  for (const e of readdirSync(pkgDir, { withFileTypes: true })) {
    if (e.isFile() && DOC_RE.test(e.name) && !KEEP_RE.test(e.name)) {
      drop(join(pkgDir, e.name));
      files++;
    }
  }
}

/** Walk a node_modules tree: prune each package, then its files and nested node_modules. */
function walkModules(nm) {
  for (const e of readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = join(nm, e.name);
    if (e.name.startsWith("@")) {
      for (const s of readdirSync(p, { withFileTypes: true })) if (s.isDirectory()) visitPackage(join(p, s.name));
    } else visitPackage(p);
  }
}
function visitPackage(pkgDir) {
  let pj = null;
  try {
    pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    /* not a package root */
  }
  if (pj && KEEP_PKGS.has(pj.name)) return;
  prunePackage(pkgDir);
  walkFiles(pkgDir);
}
function walkFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") walkModules(p);
      else if (e.name !== "skills") walkFiles(p);
    } else if (e.isFile() && FILE_RE.test(e.name) && !KEEP_RE.test(e.name)) {
      drop(p);
      files++;
    }
  }
}

/** Every node_modules folder in the stage (not descending into them; walkModules does that). */
function findModuleRoots(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.name === "node_modules") out.push(p);
    else findModuleRoots(p, out);
  }
  return out;
}

for (const nm of findModuleRoots(stage)) walkModules(nm);
const label = DRY ? "would prune" : "pruned";
console.log(`${label} ${files} files + ${dirsGone.length} folders, ${(bytes / 1048576).toFixed(1)} MB (maps, type declarations, docs, unreferenced src/test)`);
if (process.env.PRUNE_VERBOSE) for (const d of dirsGone) console.log(`  ${d.split(sep).join("/")}`);
