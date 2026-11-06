#!/usr/bin/env node
// Prepares the Live Activity widget sources for a build flavour (release-flavour.js), before
// `expo prebuild`. The widget target folder is compiled as a whole, so files cannot be left out
// per flavour; this rewrites the two that differ instead:
//   - BundledAvatars.swift: the public flavour ships no built-in bot avatars (empty table), unless
//     the build names a folder of them (PASEO_BUNDLED_AVATARS_DIR: <bot-id>.png, at most 128 px,
//     e.g. made with scripts/gen-bundled-avatars.sh's sips step). They never go into git: the
//     folder is a build input. Why: on a phone the widget cannot read the shared keychain where the
//     app stores each bot's icon (la-keychain, builds 14 and 24), and the App Group copy needs
//     PASEO_APP_GROUP=1 and a registered group; without either, built-in avatars are the only way
//     the Live Activity shows an avatar rather than the Lucide tile (la-avatars, DinoBot 0.1.3 (4)).
//   - Info.plist PaseoSharedKeychainGroup: the flavour's shared keychain group.
// "own" changes nothing (the checked-in files are the own build; with PASEO_BUNDLE_ID only the
// keychain group follows it). Undo with
// `git checkout -- targets/live-activity`.
//
// Runs automatically in `expo prebuild` for the public flavour (plugins/with-flavour-sources.js).
// Usage: PASEO_FLAVOUR=public node scripts/apply-flavour.mjs [--check]
//   --check  exit 1 if the files do not match the flavour yet (CI / ship script guard)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { resolveFlavour } = require("../release-flavour.js");

const TABLE_RE = /( {2}static let table: \[String: String\] = \[)[\s\S]*?(\n {2}\])/;

/**
 * BundledAvatars.swift with `avatars` (bot id -> base64 PNG) as its table, sorted by id; an empty
 * table when there are none (the lookup code stays).
 * @param {string} swift
 * @param {Record<string, string>} avatars
 */
export function withBundledAvatars(swift, avatars) {
  if (!TABLE_RE.test(swift)) throw new Error("BundledAvatars.swift: table not found");
  const ids = Object.keys(avatars).sort();
  if (!ids.length) return swift.replace(TABLE_RE, "$1:$2");
  const rows = ids.map((id) => `\n    ${JSON.stringify(id)}: ${JSON.stringify(avatars[id])},`);
  return swift.replace(TABLE_RE, (_m, open, close) => `${open}${rows.join("")}${close}`);
}

/** BundledAvatars.swift with an empty table (the lookup code stays). */
export function withoutBundledAvatars(swift) {
  return withBundledAvatars(swift, {});
}

const BOT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The widget draws icons at 96 px; anything much bigger only costs the extension memory. */
const MAX_BUNDLED_PX = 128;
const MAX_BUNDLED_BYTES = 64 * 1024;

/**
 * The `<bot-id>.png` files in `dir` as bot id -> base64. Other files are ignored. Throws (failing
 * the prebuild) on a bad id, a file that is not a PNG, one over 128 px or over 64 KB.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function readBundledAvatars(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".png")) continue;
    const id = name.slice(0, -4);
    if (!BOT_ID.test(id)) throw new Error(`bundled avatars: ${name}: not a bot id`);
    const data = readFileSync(join(dir, name));
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error(`bundled avatars: ${name}: not a PNG`);
    }
    const w = data.readUInt32BE(16);
    const h = data.readUInt32BE(20);
    if (w > MAX_BUNDLED_PX || h > MAX_BUNDLED_PX) {
      throw new Error(`bundled avatars: ${name}: ${w}x${h}, at most ${MAX_BUNDLED_PX} px`);
    }
    if (data.length > MAX_BUNDLED_BYTES) {
      throw new Error(
        `bundled avatars: ${name}: ${data.length} bytes, at most ${MAX_BUNDLED_BYTES}`,
      );
    }
    out[id] = data.toString("base64");
  }
  return out;
}

/** The bundled avatars this build names (PASEO_BUNDLED_AVATARS_DIR), else none. */
function bundledFromEnv(env) {
  const dir = env.PASEO_BUNDLED_AVATARS_DIR;
  return dir ? readBundledAvatars(dir) : {};
}

/** Info.plist with PaseoSharedKeychainGroup set to `group`. */
export function withKeychainGroup(plist, group) {
  const re = /(<key>PaseoSharedKeychainGroup<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (!re.test(plist)) throw new Error("Info.plist: PaseoSharedKeychainGroup not found");
  return plist.replace(re, `$1${group}$2`);
}

/**
 * @param {{ id: string, sharedKeychainGroup: string }} flavour
 * @param {Record<string, string>} files
 * @param {Record<string, string>} [bundled] bot id -> base64 PNG for the widget (public flavour)
 */
export function planFlavour(flavour, files, bundled = {}) {
  if (flavour.id === "own") {
    // Only the keychain group, and only when PASEO_BUNDLE_ID moved it off the placeholder.
    const plist = withKeychainGroup(files["Info.plist"], flavour.sharedKeychainGroup);
    return plist === files["Info.plist"] ? {} : { "Info.plist": plist };
  }
  return {
    "BundledAvatars.swift": withBundledAvatars(files["BundledAvatars.swift"], bundled),
    "Info.plist": withKeychainGroup(files["Info.plist"], flavour.sharedKeychainGroup),
  };
}

/**
 * The env apply-flavour resolves at prebuild: the build's own env (PASEO_BUNDLE_ID, PASEO_APNS_ENVIRONMENT, …)
 * with the flavour id on top. Passing only PASEO_FLAVOUR would drop PASEO_BUNDLE_ID, so the widget's
 * PaseoSharedKeychainGroup would name the placeholder (com.example.dinobot.shared) while its entitlement
 * names the real group, and the Live Activity could not read the bot icons.
 * @param {string} flavourId
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string | undefined>}
 */
export function flavourSourcesEnv(flavourId, env = process.env) {
  return { ...env, PASEO_FLAVOUR: flavourId };
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
  const plan = planFlavour(resolveFlavour(env), files, bundledFromEnv(env));
  const changed = Object.keys(plan).filter((n) => plan[n] !== files[n]);
  for (const n of changed) writeFileSync(join(WIDGET_DIR, n), plan[n]);
  return changed;
}

function main(argv) {
  const flavour = resolveFlavour();
  const files = readWidget();
  const plan = planFlavour(flavour, files, bundledFromEnv(process.env));
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
