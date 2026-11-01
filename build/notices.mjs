#!/usr/bin/env node
// Licence files for the tarball (rel-licence §1.2, the owner's licence answers 27 Oct):
//   node build/notices.mjs <stage dir> <licences dir>
// Writes <stage>/THIRD_PARTY_NOTICES.txt: every npm package in the stage (daemon, pi, bots,
// pi-packages), with its licence id and the text of its LICENSE/NOTICE files (or, when a package
// ships none, its id, author and a pointer to the standard text), plus the non-npm parts
// (daemon/bots/push NOTICEs, pi-optchat with its Taelin credit, Node, herdr and its statically
// linked crates, pi, libheif-js under LGPL-3.0). Also fails when a part has no LICENSE file.
// Fails (exit 1) when a package's licence is missing, UNKNOWN or proprietary, so a new
// dependency cannot slip in unreviewed. KNOWN maps packages whose package.json omits the field.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [stage, licences] = process.argv.slice(2);
if (!stage || !licences) {
  console.error("usage: notices.mjs <stage> <licences dir>");
  process.exit(2);
}

// Packages whose package.json has no "license" but whose licence is known (source checked).
const KNOWN = {
  "@getpaseo/cli": "Apache-2.0",
  "@getpaseo/server": "Apache-2.0",
  "@getpaseo/client": "Apache-2.0",
  "@getpaseo/protocol": "Apache-2.0",
  "@getpaseo/relay": "Apache-2.0",
  "@getpaseo/highlight": "Apache-2.0",
  "@getpaseo/plugin": "Apache-2.0",
  "@earendil-works/pi-coding-agent": "MIT",
};
// Dual licences: the one we take.
const CHOOSE = { "(AFL-2.1 OR BSD-3-Clause)": "BSD-3-Clause", "(MIT OR CC0-1.0)": "MIT", "BSD-3-Clause OR GPL-2.0": "BSD-3-Clause", "(MPL-2.0 OR Apache-2.0)": "Apache-2.0" };
const BAD = /^(UNKNOWN|UNLICENSED|SEE LICENSE|Proprietary|Commercial)/i;
const FILES = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const LICENCE_DIRS = /^(licen[cs]es|third[-_]party[-_]licen[cs]es)$/i;

function licenceOf(pkg) {
  let l = pkg.license ?? pkg.licenses;
  if (Array.isArray(l)) l = l.map((x) => x.type ?? x).join(" OR ");
  if (l && typeof l === "object") l = l.type;
  if (!l) l = KNOWN[pkg.name];
  return l ? CHOOSE[l] ?? l : "UNKNOWN";
}

const seen = new Map();
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const pj = join(dir, "package.json");
  if (existsSync(pj) && /node_modules[/\\](@[^/\\]+[/\\])?[^/\\]+$/.test(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
      if (pkg.name && pkg.version) {
        const key = `${pkg.name}@${pkg.version}`;
        if (!seen.has(key)) {
          const files = entries.filter((e) => e.isFile() && FILES.test(e.name)).map((e) => join(dir, e.name));
          // Licences of code bundled inside the package (e.g. pi-mcp's LICENSES/).
          for (const d of entries.filter((e) => e.isDirectory() && LICENCE_DIRS.test(e.name))) {
            for (const f of readdirSync(join(dir, d.name), { withFileTypes: true })) if (f.isFile()) files.push(join(dir, d.name, f.name));
          }
          seen.set(key, { name: pkg.name, version: pkg.version, licence: licenceOf(pkg), files, author: typeof pkg.author === "string" ? pkg.author : pkg.author?.name, where: relative(stage, dir) });
        }
      }
    } catch {}
  }
  for (const e of entries) {
    if (e.isDirectory() || (e.isSymbolicLink() && statSafe(join(dir, e.name))?.isDirectory())) {
      if (e.isSymbolicLink()) continue; // linked copies are walked where they live
      walk(join(dir, e.name));
    }
  }
}
function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

for (const top of ["daemon", "pi", "bots", "apns", "pi-packages", "optchat", "node/lib/node_modules"]) walk(join(stage, top));
// Every part of the tarball carries its own licence file (Apache-2.0 4(a), MIT): a part added
// without one stops the build. Parts that are absent (no herdr, no push plugin) are skipped.
const PARTS = { node: "LICENSE", daemon: "LICENSE", pi: "LICENSE", herdr: "LICENSE", optchat: "LICENSE", bots: "LICENSE", apns: "LICENSE" };
const unlicensed = Object.entries(PARTS).filter(([dir, f]) => existsSync(join(stage, dir)) && !existsSync(join(stage, dir, f))).map(([dir, f]) => `${dir}/${f}`);
for (const f of ["LICENSE", "NOTICE"]) if (!existsSync(join(stage, f))) unlicensed.push(f);
if (unlicensed.length) {
  console.error(`Missing licence files in the tarball: ${unlicensed.join(", ")}`);
  process.exit(1);
}
const pkgs = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const bad = pkgs.filter((p) => BAD.test(p.licence) && !(p.name === "@anthropic-ai/claude-agent-sdk" && p.version.includes("dinobot-stub")));
if (bad.length) {
  console.error("Packages without an acceptable licence (fix or add to KNOWN after checking the source):");
  for (const p of bad) console.error(`  ${p.name}@${p.version} ${p.licence} (${p.where})`);
  process.exit(1);
}

const read = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n").trimEnd();
const rule = "=".repeat(78);
const out = [];
const product = JSON.parse(readFileSync(new URL("../lib/product.json", import.meta.url), "utf8"));
out.push(`${product.name} host software: third-party notices
Copyright 2026 omcdowell. ${product.name}'s own parts (installer, bots plugin) are Apache-2.0 (LICENSE,
NOTICE). The daemon is a modified Paseo (Apache-2.0, daemon/LICENSE and daemon/NOTICE).
Everything else below keeps its own licence. Generated by build/notices.mjs at build time.

Not included: the Claude Agent SDK (proprietary). daemon/node_modules/@anthropic-ai/
claude-agent-sdk is a placeholder; \`${product.id} claude-code install\` fetches the real one.
`);

// The parts that are not npm packages, with the licence files they carry in the stage.
const sections = [
  ["The daemon (daemon/): modified Paseo, Apache-2.0", [join(stage, "daemon", "NOTICE")]],
  ["The bots plugin (bots/), Apache-2.0", [join(stage, "bots", "NOTICE")]],
  ["The push plugin (apns/), Apache-2.0", [join(stage, "apns", "NOTICE")]],
  ["pi-optchat (optchat/), MIT", [join(stage, "optchat", "LICENSE"), join(stage, "optchat", "THIRD_PARTY_NOTICES.md")]],
  ["Node.js (node/)", [join(licences, "node-LICENSE")]],
  ["pi (pi/), Copyright (c) 2025 Mario Zechner, MIT", [join(licences, "pi-LICENSE")]],
  ["herdr (herdr/), Apache-2.0", [join(licences, "herdr-NOTICE")]],
  ["libheif-js (LGPL-3.0)", [join(licences, "libheif-NOTICE")]],
];
// Native libraries inside npm packages whose package has no notice for them.
if ([...seen.values()].some((p) => /^sherpa-onnx-(linux|darwin|win)/.test(p.name))) {
  sections.push(["ONNX Runtime and sherpa-onnx (speech recognition)", [join(licences, "onnxruntime-NOTICE")]]);
}
// rg and fd (tools/, unmodified release binaries for pi): their own licence files.
for (const [tool, title] of [["rg", "ripgrep (tools/rg/), MIT OR Unlicense, Copyright (c) 2015 Andrew Gallant"], ["fd", "fd (tools/fd/), MIT OR Apache-2.0, Copyright (c) 2017-present The fd developers"]]) {
  const dir = join(stage, "tools", tool);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => f !== tool).sort();
  sections.push([title, [], files.map((f) => `[${f}]\n${read(join(dir, f))}`).join("\n\n")]);
}
for (const [title, files, text] of sections) {
  if (text) {
    out.push(rule, title, rule, text, "");
    continue;
  }
  const present = files.filter((f) => existsSync(f));
  if (!present.length) continue;
  out.push(rule, title, rule, ...present.flatMap((f) => [read(f), ""]));
}

const tally = {};
for (const p of pkgs) tally[p.licence] = (tally[p.licence] ?? 0) + 1;
out.push(rule, `npm packages (${pkgs.length}): ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ")}`, rule, "");
for (const p of pkgs) {
  out.push(`--- ${p.name}@${p.version}  (${p.licence})  ${p.where}`);
  if (p.files.length) for (const f of p.files) out.push(read(f), "");
  else out.push(`No licence file in the package. Licence: ${p.licence}${p.author ? `, author ${p.author}` : ""}. Standard text: https://spdx.org/licenses/${encodeURIComponent(p.licence.replace(/[()]/g, "").split(" ")[0])}.html`, "");
}
writeFileSync(join(stage, "THIRD_PARTY_NOTICES.txt"), `${out.join("\n")}\n`);
console.log(`  notices  ${pkgs.length} npm packages: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}`);
