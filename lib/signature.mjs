// Release signatures (lib/signing.json is the one place). Each tarball comes with
// <tarball>.sigstore.json: a keyless Sigstore bundle made by the release workflow in GitHub Actions
// (short-lived Fulcio certificate for the workflow's OIDC identity, logged in Rekor). We check it
// with cosign, pinned by version and sha256, before anything is unpacked. Fail closed: no bundle,
// no cosign, or a bundle from any other repo/workflow/ref = refuse.
//
// Same rules as install.sh (which has its own copy in shell, stamped by build/stamp-signing.mjs).
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { run as realRun } from "./util.mjs";

const HERE = import.meta.dirname;
export const SIGNING = JSON.parse(readFileSync(join(HERE, "signing.json"), "utf8"));

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The certificate identity cosign must see (the SAN of the Fulcio certificate). */
export function identityRegexp(cfg = SIGNING) {
  return `^https://github\\.com/${reEscape(cfg.repo)}/${reEscape(cfg.workflow)}@refs/tags/${cfg.tagPattern}`;
}

/** sigstore/cosign's release asset for this computer, and the pinned sha256. */
export function cosignAsset(p, cfg = SIGNING) {
  const arch = p.arch === "x64" ? "amd64" : p.arch;
  return {
    name: `cosign-${p.os}-${arch}`,
    sha256: cfg.cosign.sha256[`${p.os}-${p.arch}`] ?? null,
    url: `https://github.com/sigstore/cosign/releases/download/${cfg.cosign.version}/cosign-${p.os}-${arch}`,
  };
}

export function signingRequired(env = process.env, cfg = SIGNING) {
  if (cfg.mode === "off") return false;
  if (env.DINOBOT_ALLOW_UNSIGNED === "1" || env.DINOBOT_ALLOW_UNVERIFIED === "1") return false;
  return true;
}

export async function sha256File(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** "GitVersion: v3.1.4" -> 3 (null when it is not cosign). */
export function cosignMajor(versionOutput) {
  const m = /GitVersion:\s*v?(\d+)\./.exec(versionOutput ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * A cosign we trust, in this order: DINOBOT_COSIGN (explicit), ~/.<id>/tools/cosign if it matches
 * the pin, cosign v3+ on PATH, else download the pinned release into tools/. Returns {path} or {why}.
 */
export async function ensureCosign(L, { p, env = process.env, cfg = SIGNING, deps = {} } = {}) {
  const run = deps.run ?? realRun;
  if (env.DINOBOT_COSIGN) return existsSync(env.DINOBOT_COSIGN) ? { path: env.DINOBOT_COSIGN, from: "env" } : { why: `DINOBOT_COSIGN=${env.DINOBOT_COSIGN} does not exist` };
  const asset = cosignAsset(p, cfg);
  if (!asset.sha256) return { why: `no pinned cosign for ${p.os}-${p.arch}` };
  const tools = join(L.root, "tools");
  const cached = join(tools, "cosign");
  if (existsSync(cached) && (await sha256File(cached)) === asset.sha256) return { path: cached, from: "cache" };
  const onPath = await run("cosign", ["version"], { timeout: 15_000 });
  if (onPath.code === 0 && (cosignMajor(onPath.stdout + onPath.stderr) ?? 0) >= 3) return { path: "cosign", from: "path" };
  mkdirSync(tools, { recursive: true });
  const part = `${cached}.part`;
  const url = env.DINOBOT_COSIGN_BASE_URL ? `${env.DINOBOT_COSIGN_BASE_URL.replace(/\/$/, "")}/${asset.name}` : asset.url;
  const dl = await run("curl", ["-fsSL", "--retry", "2", "-o", part, url], { timeout: 15 * 60_000 });
  if (dl.code !== 0) {
    rmSync(part, { force: true });
    return { why: `could not download cosign (${dl.stderr.trim().split("\n").pop() || `curl exit ${dl.code}`})` };
  }
  const got = await sha256File(part);
  if (got !== asset.sha256) {
    rmSync(part, { force: true });
    return { why: `the cosign download does not match its pinned checksum (got ${got.slice(0, 12)})` };
  }
  chmodSync(part, 0o755);
  renameSync(part, cached);
  return { path: cached, from: "download" };
}

/** cosign's arguments: the identity, issuer and repository all pinned. */
export function verifyArgs(file, bundle, cfg = SIGNING) {
  return [
    "verify-blob", file,
    "--bundle", bundle,
    "--certificate-identity-regexp", identityRegexp(cfg),
    "--certificate-oidc-issuer", cfg.issuer,
    "--certificate-github-workflow-repository", cfg.repo,
  ];
}

/** Checks `file` against `bundle`. {ok:true} or {ok:false, why}. */
export async function verifySignature({ file, bundle, cosign, L, cfg = SIGNING, env = process.env, deps = {} }) {
  const run = deps.run ?? realRun;
  if (!bundle || !existsSync(bundle)) return { ok: false, why: "the release has no signature" };
  // Sigstore's trust root (TUF) is cached inside our own folder, not ~/.sigstore.
  const tufRoot = join(L.root, "tools", "sigstore");
  mkdirSync(tufRoot, { recursive: true });
  const r = await run(cosign, verifyArgs(file, bundle, cfg), { timeout: 120_000, env: { ...env, TUF_ROOT: tufRoot } });
  if (r.code === 0) return { ok: true };
  const last = `${r.stderr}\n${r.stdout}`.trim().split("\n").filter(Boolean).pop() ?? `cosign exit ${r.code}`;
  return { ok: false, why: last.replace(/^Error:\s*/, "") };
}
