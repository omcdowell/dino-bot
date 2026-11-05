#!/usr/bin/env node
// Generates src/licences/licences.generated.json for Settings -> About -> Licences (release/app):
//   - the product notice (the repo NOTICE: DinoBot, Copyright 2026 omcdowell, modified Paseo,
//     brand assets not licensed), shown first in the public build,
//   - the app's own licence (the repo LICENSE: Apache-2.0, Copyright (c) 2025-present Mohamed Boudra),
//   - extra notices (the host software the installer sets up on the computer, see EXTRA below;
//     its full list is THIRD_PARTY_NOTICES.txt in the installer tarball),
//   - every npm package the app bundles (production dependencies of packages/app, transitively),
//     with its licence id, its copyright lines and its licence file text. Identical texts are
//     stored once.
// Run after dependency changes: node scripts/gen-licences.mjs  (no network; reads node_modules).
// CocoaPods/Swift packages: the Expo modules' pods are the npm packages above; no other pods.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(APP, "..", "..");
const OUT = join(APP, "src", "licences", "licences.generated.json");

/** Parts that are not npm dependencies of the app but ship with the product (the host software). */
const EXTRA = [
  {
    name: "paseo-bots (bots plugin)",
    licence: "Apache-2.0",
    copyright: ["Copyright 2026 omcdowell"],
  },
  {
    name: "paseo-apns (push plugin)",
    licence: "Apache-2.0",
    copyright: ["Copyright 2026 omcdowell"],
  },
  {
    name: "pi-optchat",
    licence: "MIT",
    copyright: [
      "Copyright (c) 2026 Jonas Silva",
      "Copyright (c) 2026 omcdowell (modifications)",
      "Prompt adapted, with permission, from Victor Taelin's OptChat recipe",
    ],
  },
  {
    name: "pi",
    licence: "MIT",
    copyright: ["Copyright (c) 2025 Mario Zechner"],
  },
  {
    name: "herdr",
    licence: "Apache-2.0",
    copyright: ["herdr (github.com/herdrdev/herdr), unmodified; does not endorse this product"],
  },
  {
    name: "Node.js",
    licence: "MIT",
    copyright: ["Copyright Node.js contributors. All rights reserved."],
  },
];

/** Packages whose package.json has no SPDX id although the licence is known (source checked). */
const KNOWN_LICENCE = {
  // khroma ships an MIT licence file ("Copyright (c) 2019-present Fabio Spampinato, Andrew Maney").
  khroma: "MIT",
};

/** Dual licences: the one we take. */
const CHOOSE_LICENCE = {
  "(BSD-3-Clause OR GPL-2.0)": "BSD-3-Clause",
  "(MPL-2.0 OR Apache-2.0)": "Apache-2.0",
  "(MIT OR CC0-1.0)": "MIT",
  "(BSD-2-Clause OR MIT OR Apache-2.0)": "MIT",
  "Apache 2.0": "Apache-2.0",
};

/** Used when a package names MIT but ships no licence file (its copyright line is shown above it). */
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const LICENCE_FILE_RE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function licenceId(pkg) {
  const id = rawLicenceId(pkg);
  if (id === "UNKNOWN" && KNOWN_LICENCE[pkg.name]) return KNOWN_LICENCE[pkg.name];
  return CHOOSE_LICENCE[id] ?? id;
}

function rawLicenceId(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l))
    return l
      .map((x) => (typeof x === "string" ? x : x?.type))
      .filter(Boolean)
      .join(" OR ");
  if (l && typeof l === "object" && typeof l.type === "string") return l.type;
  return "UNKNOWN";
}

function licenceText(dir) {
  const files = readdirSync(dir)
    .filter((f) => LICENCE_FILE_RE.test(f))
    .sort();
  return files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n") || null;
}

function copyrightLines(text, pkg) {
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        /^(©|\(c\)|copyright\b)/i.test(l) &&
        !/\[yyyy\]|<year>|\{yyyy\}/i.test(l) &&
        // Licence boilerplate, not a copyright holder (Apache-2.0 sections 1-4, GPL preambles).
        !/^copyright (notice|license|owner|holder|statement|and license|laws?)\b|^\(c\) you must|^copyright \(c\) \d{4}(, \d{4})* free software foundation/i.test(
          l,
        ),
    );
  if (lines.length) return [...new Set(lines)].slice(0, 5);
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  return author ? [`Copyright (c) ${author}`] : [];
}

export function collect(appDir = APP) {
  const root = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const queue = Object.keys(root.dependencies ?? {}).map((name) => ({
    name,
    from: appDir,
  }));
  const seen = new Map();
  while (queue.length) {
    const { name, from } = queue.shift();
    const dir = findPackageDir(name, from);
    if (!dir) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    // Our own workspace packages are covered by the app's licence.
    if (pkg.name?.startsWith("@getpaseo/")) {
      seen.set(key, null);
    } else {
      const text = licenceText(dir);
      seen.set(key, {
        name: pkg.name,
        version: pkg.version,
        licence: licenceId(pkg),
        copyright: copyrightLines(text, pkg),
        text,
      });
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir });
  }
  const texts = {};
  const packages = [];
  // The plain Apache-2.0 text (from the repo LICENSE, after Paseo's preamble): for the Apache-2.0
  // host parts and for Apache-2.0 packages that ship no licence file.
  const repoLicence = readFileSync(join(REPO, "LICENSE"), "utf8");
  const apacheText = repoLicence.slice(repoLicence.search(/^\s*Apache License\s*$/m)).trim();
  const apacheId = "apache-2.0";
  const EXTRA_TEXT_IDS = { MIT: "mit", "Apache-2.0": apacheId };
  for (const entry of seen.values()) {
    if (!entry) continue;
    let textId = null;
    if (!entry.text && entry.licence === "MIT") {
      textId = "mit";
      texts.mit = MIT_TEXT;
    } else if (!entry.text && entry.licence === "Apache-2.0") {
      textId = apacheId;
    } else if (!entry.text && entry.licence !== "UNKNOWN") {
      // No licence file in the package: name the licence and where its standard text is.
      textId = `spdx:${entry.licence}`;
      texts[textId] = `Licensed under ${
        entry.licence
      }. The package ships no licence file; the standard text is at https://spdx.org/licenses/${
        entry.licence.replace(/[()]/g, "").split(" ")[0]
      }.html`;
    } else if (entry.text) {
      textId = createHash("sha1").update(entry.text).digest("hex").slice(0, 10);
      texts[textId] = entry.text;
    }
    packages.push({
      name: entry.name,
      version: entry.version,
      licence: entry.licence,
      copyright: entry.copyright,
      textId,
    });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  texts.mit = MIT_TEXT;
  texts[apacheId] = apacheText;
  return {
    app: {
      licence: "Apache-2.0",
      text: readFileSync(join(REPO, "LICENSE"), "utf8").trim(),
    },
    product: {
      notice: existsSync(join(REPO, "NOTICE"))
        ? readFileSync(join(REPO, "NOTICE"), "utf8").trim()
        : null,
    },
    extra: EXTRA.map((e) =>
      Object.assign({}, e, {
        textId: EXTRA_TEXT_IDS[e.licence] ?? null,
      }),
    ),
    packages,
    texts,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const data = collect();
  writeFileSync(OUT, `${JSON.stringify(data)}\n`);
  const kb = Math.round(JSON.stringify(data).length / 1024);
  const unknown = data.packages
    .filter((p) => p.licence === "UNKNOWN" || !p.textId)
    .map((p) => p.name);
  console.log(
    `wrote ${OUT}: ${data.packages.length} packages, ${
      Object.keys(data.texts).length
    } licence texts, ${kb} KB`,
  );
  if (unknown.length) console.log(`no licence id or file (check by hand): ${unknown.join(", ")}`);
}
