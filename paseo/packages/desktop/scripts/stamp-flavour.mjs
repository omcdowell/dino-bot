#!/usr/bin/env node
// Writes dist/flavour.json for the Electron main process (src/flavour.ts) from PASEO_FLAVOUR,
// using the app's release-flavour.js as the one place the public name and link scheme live.
// Run by `npm run build:main` after tsc. PASEO_FLAVOUR unset = "own" (Paseo, unchanged).
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { resolveFlavour } = require("../../app/release-flavour.js");

export function desktopFlavourJson(env = process.env) {
  const flavour = resolveFlavour(env);
  return {
    id: flavour.id,
    appName: flavour.appName,
    linkScheme: flavour.linkScheme,
    // DinoBot's display version (app/dinobot-version.js); null for the own build.
    displayVersion: flavour.displayVersion,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(here, "..", "dist");
  mkdirSync(out, { recursive: true });
  const json = desktopFlavourJson();
  writeFileSync(path.join(out, "flavour.json"), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`[stamp-flavour] dist/flavour.json: ${JSON.stringify(json)}`);
}
