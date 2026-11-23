#!/usr/bin/env node
// Merge-time checks on what a change adds (seconds; no install, no build):
//   1. lint: oxlint on the changed JS/TS files, paseo/ with paseo/.oxlintrc.json, everything else with
//      the root .oxlintrc.json (correctness rules and the bots import boundaries). Only findings that
//      start on an added line fail, so findings already in a file never block a merge (a rule that
//      reports a whole function, like complexity, fails only when the function's first line is new).
//   2. no new vi.mock: an added line in a test file that calls vi.mock( or vi.doMock( fails (a
//      stand-in that differs from the real object hid the 20 Nov outbox bug; use the real module).
//
//   node build/merge-checks.mjs [<base>]     base defaults to HEAD^1 (next, when HEAD is the merge)
// Compares the merge base of <base> and HEAD with HEAD. Prints findings and each check's time;
// exits 1 on any finding, 2 when it cannot run.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OXLINT = join(ROOT, "paseo/node_modules/.bin/oxlint");
const CODE = /\.(c|m)?(j|t)sx?$/;
const TEST_FILE = /(\.(test|spec)\.(c|m)?(j|t)sx?$)|(^|\/)(test|tests|__tests__|e2e)\//;
const MOCK = /\bvi\s*\.\s*(mock|doMock)\s*\(/;

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const base = git("merge-base", process.argv[2] ?? "HEAD^1", "HEAD").trim();

/** Added line numbers per file (new side), from a zero-context diff. */
function addedLines() {
  const out = new Map();
  let file = null;
  for (const line of git("diff", "-U0", "--no-color", "--diff-filter=AMR", base, "HEAD").split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
      if (file) out.set(file, new Map());
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const added = out.get(file);
      for (let n = start; n < start + count; n++) added.set(n, null);
      added.cursor = start;
      continue;
    }
    if (file && line.startsWith("+") && !line.startsWith("+++")) {
      const added = out.get(file);
      added.set(added.cursor, line.slice(1));
      added.cursor++;
    }
  }
  return out;
}

/** Runs oxlint on `files` (relative to `cwd`) and returns JSON diagnostics. */
function oxlint(cwd, args, files) {
  if (!files.length) return [];
  const r = spawnSync(OXLINT, [...args, "-f", "json", ...files], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    console.error(`oxlint gave no JSON (exit ${r.status}):\n${r.stdout}${r.stderr}`);
    process.exit(2);
  }
  return parsed.diagnostics.map((d) => ({ ...d, filename: relative(ROOT, join(cwd, d.filename)) }));
}

const added = addedLines();
const findings = [];
const timings = [];

// 1. lint
let t = performance.now();
if (!existsSync(OXLINT)) {
  console.error(`no oxlint at ${relative(ROOT, OXLINT)} (paseo/node_modules not installed)`);
  process.exit(2);
}
const changed = [...added.keys()].filter((f) => CODE.test(f) && existsSync(join(ROOT, f)));
const paseoFiles = changed.filter((f) => f.startsWith("paseo/")).map((f) => f.slice("paseo/".length));
const ownFiles = changed.filter((f) => !f.startsWith("paseo/"));
const diagnostics = [
  ...oxlint(join(ROOT, "paseo"), [], paseoFiles),
  ...oxlint(ROOT, ["--disable-nested-config", "-c", ".oxlintrc.json"], ownFiles),
];
for (const d of diagnostics) {
  if (d.severity !== "error") continue;
  const lines = added.get(d.filename);
  const label = d.labels?.[0];
  if (!lines || !label) continue;
  const line = label.span.line;
  if (!lines.has(line)) continue;
  findings.push(`${d.filename}:${line}: ${d.code}: ${d.message}${d.help ? ` (${d.help})` : ""}`);
}
timings.push(`lint ${changed.length} changed file(s) ${((performance.now() - t) / 1000).toFixed(1)}s`);

// 2. no new vi.mock in tests
t = performance.now();
let mockLines = 0;
for (const [file, lines] of added) {
  if (!TEST_FILE.test(file)) continue;
  for (const [n, text] of lines) {
    if (text !== null && MOCK.test(text)) {
      mockLines++;
      findings.push(`${file}:${n}: new vi.mock: test with the real module (or a real fake passed in), not a module mock`);
    }
  }
}
timings.push(`vi.mock scan ${((performance.now() - t) / 1000).toFixed(1)}s`);

for (const f of findings) console.log(f);
console.log(`merge-checks ${base.slice(0, 9)}..HEAD: ${findings.length} finding(s) (${mockLines} vi.mock); ${timings.join("; ")}`);
process.exit(findings.length ? 1 : 0);
