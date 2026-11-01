#!/usr/bin/env node
// Prepares the Live Activity widget sources for a build flavour (release-flavour.js), before
// `expo prebuild`. The widget target folder is compiled as a whole, so files cannot be left out
// per flavour; this rewrites the two that differ instead:
//   - BundledAvatars.swift: the public flavour ships no built-in bot avatars (empty table; the
//     keychain icon sync still gives every bot its avatar).
//   - Info.plist PaseoSharedKeychainGroup: the flavour's shared keychain group.
// "own" changes nothing (the checked-in files are the own build; with PASEO_BUNDLE_ID only the
// keychain group follows it). Undo with
// `git checkout -- targets/live-activity`.
//
// Runs automatically in `expo prebuild` for the public flavour (plugins/with-flavour-sources.js).
// Usage: PASEO_FLAVOUR=public node scripts/apply-flavour.mjs [--check]
//   --check  exit 1 if the files do not match the flavour yet (CI / ship script guard)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { resolveFlavour } = require("../release-flavour.js");

const TABLE_RE = /( {2}static let table: \[String: String\] = \[)[\s\S]*?(\n {2}\])/;

/** BundledAvatars.swift with an empty table (the lookup code stays). */
export function withoutBundledAvatars(swift) {
  if (!TABLE_RE.test(swift)) throw new Error("BundledAvatars.swift: table not found");
  return swift.replace(TABLE_RE, "$1:$2");
}

/** Info.plist with PaseoSharedKeychainGroup set to `group`. */
export function withKeychainGroup(plist, group) {
  const re = /(<key>PaseoSharedKeychainGroup<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (!re.test(plist)) throw new Error("Info.plist: PaseoSharedKeychainGroup not found");
  return plist.replace(re, `$1${group}$2`);
}

export function planFlavour(flavour, files) {
  if (flavour.id === "own") {
    // Only the keychain group, and only when PASEO_BUNDLE_ID moved it off the placeholder.
    const plist = withKeychainGroup(files["Info.plist"], flavour.sharedKeychainGroup);
    return plist === files["Info.plist"] ? {} : { "Info.plist": plist };
  }
  return {
    "BundledAvatars.swift": withoutBundledAvatars(files["BundledAvatars.swift"]),
    "Info.plist": withKeychainGroup(files["Info.plist"], flavour.sharedKeychainGroup),
  };
}

const WIDGET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "targets", "live-activity");
const WIDGET_FILES = ["BundledAvatars.swift", "Info.plist"];

function readWidget() {
  return Object.fromEntries(
    WIDGET_FILES.map((n) => [n, readFileSync(join(WIDGET_DIR, n), "utf8")]),
  );
}

/** Rewrites the widget sources for the flavour in `env`; returns the changed file names. */
export function applyFlavour(env = process.env) {
  const files = readWidget();
  const plan = planFlavour(resolveFlavour(env), files);
  const changed = Object.keys(plan).filter((n) => plan[n] !== files[n]);
  for (const n of changed) writeFileSync(join(WIDGET_DIR, n), plan[n]);
  return changed;
}

function main(argv) {
  const flavour = resolveFlavour();
  const files = readWidget();
  const plan = planFlavour(flavour, files);
  const changed = Object.keys(plan).filter((n) => plan[n] !== files[n]);
  if (argv.includes("--check")) {
    if (changed.length) {
      console.error(
        `flavour ${flavour.id}: not applied to ${changed.join(
          ", ",
        )}; run scripts/apply-flavour.mjs`,
      );
      process.exit(1);
    }
    console.log(`flavour ${flavour.id}: widget sources match`);
    return;
  }
  for (const n of changed) writeFileSync(join(WIDGET_DIR, n), plan[n]);
  console.log(
    `flavour ${flavour.id}: ${
      changed.length ? `rewrote ${changed.join(", ")}` : "nothing to change"
    }`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
