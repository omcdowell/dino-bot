#!/usr/bin/env node
// Stamps lib/signing.json into an install.sh copy (the SIGNING_MODE … COSIGN_SHA256S lines), so the
// shell installer and lib/signature.mjs check exactly the same identity with the same cosign.
//   node build/stamp-signing.mjs <install.sh> [signing.json]     (in place)
// test/signing.test.mjs checks the checked-in install.sh is already stamped (no drift).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityRegexp } from "../lib/signature.mjs";

const HERE = join(import.meta.dirname, "..");

export function stampSigning(sh, cfg) {
  if (/'/.test(identityRegexp(cfg))) throw new Error("identity regexp must not contain a single quote");
  const lines = {
    SIGNING_MODE: `"${cfg.mode}"`,
    SIGNER_REPO: `"${cfg.repo}"`,
    SIGNER_IDENTITY_RE: `'${identityRegexp(cfg)}'`,
    SIGNER_ISSUER: `"${cfg.issuer}"`,
    SIG_SUFFIX: `"${cfg.bundleSuffix}"`,
    COSIGN_VERSION: `"${cfg.cosign.version}"`,
    COSIGN_SHA256S: `"${Object.entries(cfg.cosign.sha256).map(([k, v]) => `${k}=${v}`).join(" ")}"`,
  };
  let out = sh;
  for (const [k, v] of Object.entries(lines)) {
    const re = new RegExp(`^${k}=("[^"]*"|'[^']*')`, "m");
    if (!re.test(out)) throw new Error(`install.sh has no ${k}= line`);
    out = out.replace(re, () => `${k}=${v}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, cfgPath = join(HERE, "lib", "signing.json")] = process.argv.slice(2);
  if (!file) { console.error("usage: stamp-signing.mjs <install.sh> [signing.json]"); process.exit(2); }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(file, stampSigning(readFileSync(file, "utf8"), cfg));
}
