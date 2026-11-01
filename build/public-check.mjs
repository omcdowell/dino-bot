#!/usr/bin/env node
// Is this tree fit to be public? Lists what must not be in the public repo (exit 1 if anything).
//
//   node build/public-check.mjs DIR [DIR…]     files: `git ls-files` in a git checkout, else every file
//
// Always checked:
//   - friend-test pages (FRIEND-SETUP.md) anywhere in the tree
//   - Tailscale (CGNAT) addresses 100.64.0.0/10, except the two documentation blocks the tests use:
//     100.64.0.0/24 and 100.127.255.0/24 (range edges)
//   - this computer's own details, read at run time so they never have to be written down here:
//     its tailnet addresses and MagicDNS suffix (`tailscale status --json`), its host name, and its
//     home folder path
// Optional, kept OUTSIDE the tree: DINOBOT_PRIVATE_PATTERNS (default
// ~/.config/dinobot/private-patterns.txt), one case-insensitive regex per line (names, ids, routes);
// a hit is reported by line number of that file, never by the matched text.
// Known false positives (e.g. upstream test fixtures): DINOBOT_PUBLIC_CHECK_ALLOW (default
// ~/.config/dinobot/public-check-allow.txt), lines "<file regex> <text the reason contains>".
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join, relative } from "node:path";

export const FRIEND_FILES = /^friend-setup\.md$/i;
const IPV4 = /(?<![\d.])100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d])/g;

/** True for an address in Tailscale's 100.64.0.0/10 that is not a documentation/test block. */
/** a, b, c: the 2nd, 3rd and 4th octet of 100.a.b.c. */
export function realTailnetIp(a, b, c) {
  if (a > 255 || b > 255 || c > 255) return false;
  if (a < 64 || a > 127) return false; // not CGNAT
  if (a === 64 && b === 0) return false; // 100.64.0.0/24: test fixtures
  if (a === 127 && b === 255) return false; // 100.127.255.0/24: range edge in tests
  if (a === 101 && b === 102 && c === 103) return false; // 100.101.102.103: Tailscale's own docs example
  return true;
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  } catch {
    return "";
  }
}

/** This computer's identifying strings (never stored in the tree). */
export function localNeedles(env = process.env) {
  const out = [];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Host names match as whole words (a host called "mini" must not flag "minimal"); the rest as text.
  const add = (kind, s, word = false) =>
    s && s.length >= 4 && out.push({ kind, re: new RegExp(word ? `(?<![\\w-])${esc(s)}(?![\\w-])` : esc(s), "i") });
  if (env.DINOBOT_PUBLIC_CHECK_LOCAL === "0") return out;
  try {
    const st = JSON.parse(sh("tailscale", ["status", "--json"]) || "{}");
    for (const n of [st.Self, ...Object.values(st.Peer ?? {})].filter(Boolean)) {
      for (const ip of n.TailscaleIPs ?? []) add("this tailnet's address", ip);
      add("this tailnet's host name", (n.DNSName ?? "").split(".")[0], true);
    }
    add("this tailnet's MagicDNS suffix", st.MagicDNSSuffix);
  } catch {}
  add("this computer's host name", hostname().split(".")[0], true);
  const home = homedir();
  if (home && home !== "/" && home !== "/root") add("this computer's home folder", home);
  try {
    const u = userInfo().username;
    if (u.length >= 3) for (const p of [`/home/${u}/`, `/Users/${u}/`]) add("this computer's home folder", p);
  } catch {}
  return out;
}

export function privatePatterns(env = process.env) {
  const f = env.DINOBOT_PRIVATE_PATTERNS ?? join(homedir(), ".config", "dinobot", "private-patterns.txt");
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter(({ l }) => l && !l.startsWith("#"))
    .map(({ n, l }) => ({ n, re: new RegExp(l, "i") }));
}

export function allowList(env = process.env) {
  const f = env.DINOBOT_PUBLIC_CHECK_ALLOW ?? join(homedir(), ".config", "dinobot", "public-check-allow.txt");
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [file, ...why] = l.split(/\s+/);
      return { file: new RegExp(file), why: why.join(" ") };
    });
}

function listFiles(dir) {
  if (existsSync(join(dir, ".git"))) {
    return sh("git", ["-C", dir, "ls-files", "-z"]).split("\0").filter(Boolean);
  }
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(relative(dir, p));
    }
  };
  walk(dir);
  return files;
}

/** Problems in DIR: [{ file, line, why }]. */
export function checkTree(dir, { needles = localNeedles(), patterns = privatePatterns(), allow = allowList() } = {}) {
  const problems = [];
  for (const f of listFiles(dir)) {
    if (FRIEND_FILES.test(basename(f))) problems.push({ file: f, line: 0, why: "friend-test page" });
    const p = join(dir, f);
    let text;
    try {
      if (!statSync(p).isFile() || statSync(p).size > 20e6) continue;
      const buf = readFileSync(p);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((ln, i) => {
      for (const m of ln.matchAll(IPV4)) {
        if (realTailnetIp(+m[1], +m[2], +m[3])) problems.push({ file: f, line: i + 1, why: `Tailscale address ${m[0]}` });
      }
      for (const n of needles) if (n.re.test(ln)) problems.push({ file: f, line: i + 1, why: n.kind });
      for (const pt of patterns) if (pt.re.test(ln)) problems.push({ file: f, line: i + 1, why: `private pattern (line ${pt.n} of the patterns file)` });
    });
  }
  return problems.filter((p) => !allow.some((a) => a.file.test(p.file) && p.why.includes(a.why)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error("usage: node build/public-check.mjs DIR [DIR…]");
    process.exit(2);
  }
  const needles = localNeedles();
  const patterns = privatePatterns();
  let n = 0;
  for (const d of dirs) {
    const ps = checkTree(d, { needles, patterns });
    for (const p of ps) console.log(`${d}/${p.file}${p.line ? `:${p.line}` : ""}: ${p.why}`);
    n += ps.length;
  }
  console.log(n ? `public-check: ${n} problem(s)` : `public-check: clean (${dirs.length} tree(s); ${needles.length} local and ${patterns.length} private pattern(s))`);
  process.exit(n ? 1 : 0);
}
