#!/usr/bin/env node
// Regenerates build/licences/herdr-NOTICE from a herdr source tree (run once per herdr bump):
//   git -C <herdr repo> archive v0.9.3 | tar -x -C /tmp/herdr-src
//   node build/herdr-crates.mjs /tmp/herdr-src v0.9.3 [target triple …]
// herdr is Apache-2.0 (relicensed from AGPL on 22 Jul 2026, cd5ea1be0) and statically links Rust
// crates plus vendored libghostty-vt (MIT) and portable-pty (MIT). This does what `cargo about
// generate` does, without installing it: `cargo metadata --locked --filter-platform <triple>`
// (downloads the crate sources into ~/.cargo/registry, nothing is compiled), every crate the herdr
// binary can link for the given targets (normal + build dependencies; dev ones left out), and each
// crate's own licence files copied verbatim, so every MIT/BSD copyright line and permission notice
// is there. Identical texts are printed once with the list of crates that use them.
// Default targets: aarch64-apple-darwin and x86_64-unknown-linux-gnu (the tarballs we build).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [src, tag = "?", ...triples] = process.argv.slice(2);
if (!src || !existsSync(join(src, "Cargo.lock"))) {
  console.error("usage: node build/herdr-crates.mjs <herdr source dir> <tag> [target triple …]");
  process.exit(2);
}
const targets = triples.length ? triples : ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"];
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._].*)?$/i;

const crates = new Map(); // id -> package
for (const t of targets) {
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", t], { cwd: src, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [...meta.workspace_members];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind !== "dev")) stack.push(d.pkg);
  }
  for (const id of seen) {
    const p = pkgs.get(id);
    if (p && !meta.workspace_members.includes(id) && p.source?.startsWith("registry+")) crates.set(`${p.name} ${p.version}`, p);
  }
}

function licenceFiles(dir) {
  return readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort().map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim() }));
}
const copyrightLines = (text) => [...new Set(text.split("\n").map((l) => l.trim()).filter((l) => (/^copyright\b/i.test(l) && !/^copyright\s+(license|licence|notice|holders?|owners?|and|statement|\[yyyy\]|\{yyyy\}|<year>)/i.test(l)) || /^(\(c\)|©)\s*\d{4}/i.test(l)))];

const texts = new Map(); // hash -> {text, users: []}
const rows = [];
let without = 0;
for (const [key, p] of [...crates].sort(([a], [b]) => a.localeCompare(b))) {
  const files = licenceFiles(dirname(p.manifest_path));
  if (!files.length) without++;
  const lines = [...new Set(files.flatMap((f) => copyrightLines(f.text)))];
  rows.push(`${key}  ${p.license ?? p.license_file ?? "?"}${lines.length ? `\n    ${lines.join("\n    ")}` : files.length ? "" : `\n    (no licence file in the crate; authors: ${(p.authors ?? []).join(", ") || "not listed"})`}`);
  for (const f of files) {
    const h = createHash("sha256").update(f.text).digest("hex");
    if (!texts.has(h)) texts.set(h, { text: f.text, users: [] });
    texts.get(h).users.push(`${key} (${f.file})`);
  }
}
const vendored = ["vendor/libghostty-vt/LICENSE", "vendor/portable-pty/LICENSE.md"].filter((f) => existsSync(join(src, f)));
for (const f of vendored) {
  const text = readFileSync(join(src, f), "utf8").trim();
  const h = createHash("sha256").update(text).digest("hex");
  if (!texts.has(h)) texts.set(h, { text, users: [] });
  texts.get(h).users.push(`herdr ${f}`);
}
const tally = {};
for (const p of crates.values()) tally[p.license ?? "?"] = (tally[p.license ?? "?"] ?? 0) + 1;
const apache = readFileSync(new URL("./licences/APACHE-2.0.txt", import.meta.url), "utf8");
const out = `herdr ${tag}, https://github.com/herdrdev/herdr
Licensed under the Apache License, Version 2.0 (full text at the end). Unmodified binary. herdr
does not endorse this product. No NOTICE file in herdr ${tag}.

Third-party code statically linked into the herdr binary, for ${targets.join(" and ")}:
${crates.size} Rust crates (from herdr's Cargo.lock via cargo metadata; dev-only crates left out) and
vendored ${vendored.map((f) => f.split("/")[1]).join(" and ")}.
Each crate is listed with its licence and the copyright lines from its own licence files; then
every distinct licence text, verbatim, with the crates that ship it.${without ? `\n${without} crate(s) ship no licence file; their authors are listed instead.` : ""}
Licence tally: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join("; ")}

== Crates ==

${rows.join("\n")}

== Licence texts ==
${[...texts.values()].map((t) => `\n---- used by: ${t.users.join(", ")}\n\n${t.text}\n`).join("")}
== herdr: Apache License 2.0 ==

${apache}`;
writeFileSync(new URL("./licences/herdr-NOTICE", import.meta.url), out);
console.log(`${crates.size} crates, ${texts.size} distinct licence texts, ${without} without a licence file, ${Math.round(out.length / 1024)} KB`, tally);
