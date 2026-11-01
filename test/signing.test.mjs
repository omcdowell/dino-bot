// Release signatures: install.sh and `dinobot update` refuse anything without a valid keyless
// Sigstore bundle from our release workflow (lib/signing.json), on top of the checksum.
//   node --test test/signing.test.mjs                (fake cosign; no network)
//   COSIGN_REAL_DIR=<dir> node --test test/signing.test.mjs
//     also runs the real cosign against a real GitHub Actions keyless bundle. <dir> holds
//     cosign-linux-amd64 (v3.1.4) and gitsign_0.18.0_linux_amd64 + .bundle from
//     github.com/sigstore/{cosign,gitsign} releases (gitsign is signed exactly as we sign:
//     .github/workflows/release.yml at a v* tag, issuer token.actions.githubusercontent.com).
// Temp dirs under ./.test-tmp-sig (never /tmp).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { stampSigning } from "../build/stamp-signing.mjs";
import { cosignAsset, cosignMajor, ensureCosign, identityRegexp, SIGNING, signingRequired, verifyArgs, verifySignature } from "../lib/signature.mjs";
import { layout, PRODUCT, PRODUCT_ID } from "../lib/util.mjs";

const HERE = join(import.meta.dirname, "..");
const TMP = join(HERE, ".test-tmp-sig");
mkdirSync(TMP, { recursive: true });
const tmp = () => mkdtempSync(join(TMP, "t-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "x64" ? "x64" : "arm64";
const P = { os: OS, arch: ARCH };
const INSTALL_SH = readFileSync(join(HERE, "install.sh"), "utf8");

/** A fake cosign: logs its args and TUF_ROOT, exits FAKE_COSIGN_RC (default 0). */
function fakeCosign(dir) {
  const f = join(dir, "cosign");
  writeFileSync(f, `#!/bin/sh
[ "$1" = version ] && { echo "GitVersion:    v3.9.9"; exit 0; }
printf '%s\\n' "$@" > "\${FAKE_COSIGN_LOG:-/dev/null}"
echo "TUF_ROOT=$TUF_ROOT" >> "\${FAKE_COSIGN_LOG:-/dev/null}"
[ "\${FAKE_COSIGN_RC:-0}" = 0 ] && { echo "Verified OK" >&2; exit 0; }
echo "Error: none of the expected identities matched what was in the certificate" >&2; exit 1
`);
  chmodSync(f, 0o755);
  return f;
}

/** A tarball shaped like ours whose "node" only records that the wizard was started. */
function fakeRelease(dir, { checksum = true, bundle = true } = {}) {
  const name = `${PRODUCT_ID}-${OS}-${ARCH}`;
  const stage = join(dir, "stage", name);
  mkdirSync(join(stage, "node", "bin"), { recursive: true });
  mkdirSync(join(stage, "installer", "lib"), { recursive: true });
  writeFileSync(join(stage, "node", "bin", "node"), `#!/bin/sh\necho wizard > "$DINOBOT_HOME/wizard-ran"\n`);
  chmodSync(join(stage, "node", "bin", "node"), 0o755);
  writeFileSync(join(stage, "installer", "lib", "cli.mjs"), "");
  writeFileSync(join(stage, "MANIFEST.json"), JSON.stringify({ built: "test" }));
  const tar = join(dir, `${name}.tar.gz`);
  spawnSync("tar", ["-czf", tar, "-C", join(dir, "stage"), name]);
  if (checksum) writeFileSync(`${tar}.sha256`, `${sha(tar)}  ${name}.tar.gz\n`);
  if (bundle) writeFileSync(`${tar}.sigstore.json`, JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" }));
  return tar;
}

function runInstall({ script = INSTALL_SH, tarball, env = {}, home }) {
  mkdirSync(home, { recursive: true });
  const file = join(home, "install.sh");
  writeFileSync(file, script);
  const r = spawnSync("sh", [file, "--yes"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, DINOBOT_HOME: join(home, ".dinobot"), DINOBOT_NAME: "Tester", DINOBOT_TARBALL: tarball, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ...r, out: `${r.stdout}${r.stderr}`, root: join(home, ".dinobot") };
}

describe("signing config (one place)", () => {
  const product = JSON.parse(readFileSync(join(HERE, "lib", "product.json"), "utf8"));
  it("install.sh is stamped from lib/signing.json (no drift)", () => {
    assert.equal(stampSigning(INSTALL_SH, SIGNING), INSTALL_SH);
  });
  it("same repo as the releases", () => {
    if (product.releaseRepo) assert.equal(SIGNING.repo, product.releaseRepo);
    assert.match(product.downloadBaseUrl, new RegExp(`github\\.com/${SIGNING.repo}/`));
  });
  it("signing is on in the checked-in config", () => {
    assert.equal(SIGNING.mode, "cosign");
    assert.equal(signingRequired({}), true);
    assert.equal(signingRequired({ DINOBOT_ALLOW_UNSIGNED: "1" }), false);
    assert.equal(signingRequired({}, { ...SIGNING, mode: "off" }), false);
  });
  it("identity: only our release workflow at a release tag", () => {
    const re = new RegExp(identityRegexp());
    const id = (s) => `https://github.com/${s}`;
    assert.match(id("omcdowell/dino-bot/.github/workflows/release.yml@refs/tags/v0.1.0"), re);
    assert.match(id("omcdowell/dino-bot/.github/workflows/release.yml@refs/tags/v1.2.3-rc.1"), re);
    for (const bad of [
      "omcdowell/dino-bot/.github/workflows/release.yml@refs/heads/main",
      "omcdowell/dino-bot/.github/workflows/release.yml@refs/pull/1/merge",
      "omcdowell/dino-bot/.github/workflows/release.yml@refs/tags/test",
      "omcdowell/dino-bot/.github/workflows/ci.yml@refs/tags/v0.1.0",
      "omcdowell/dino-bot/.github/workflows/releaseXyml@refs/tags/v0.1.0",
      "omcdowell/dino-bot-fork/.github/workflows/release.yml@refs/tags/v0.1.0",
      "evil/dinobot/.github/workflows/release.yml@refs/tags/v0.1.0",
    ]) assert.doesNotMatch(id(bad), re, bad);
    assert.doesNotMatch("https://github.com.evil/omcdowell/dino-bot/.github/workflows/release.yml@refs/tags/v1", re);
  });
  it("cosign pins for every platform we ship", () => {
    for (const k of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) assert.match(SIGNING.cosign.sha256[k], /^[0-9a-f]{64}$/, k);
    assert.equal(cosignAsset({ os: "darwin", arch: "arm64" }).name, "cosign-darwin-arm64");
    assert.equal(cosignAsset({ os: "linux", arch: "x64" }).url, `https://github.com/sigstore/cosign/releases/download/${SIGNING.cosign.version}/cosign-linux-amd64`);
    assert.equal(cosignMajor("GitVersion:    v3.1.4\nGitCommit: x"), 3);
    assert.equal(cosignMajor("GitVersion:    v2.4.1"), 2);
    assert.equal(cosignMajor("bash: cosign: not found"), null);
  });
  it("cosign is asked for identity, issuer and repository", () => {
    const a = verifyArgs("f.tgz", "f.tgz.sigstore.json");
    assert.deepEqual(a.slice(0, 4), ["verify-blob", "f.tgz", "--bundle", "f.tgz.sigstore.json"]);
    assert.equal(a[a.indexOf("--certificate-identity-regexp") + 1], identityRegexp());
    assert.equal(a[a.indexOf("--certificate-oidc-issuer") + 1], "https://token.actions.githubusercontent.com");
    assert.equal(a[a.indexOf("--certificate-github-workflow-repository") + 1], SIGNING.repo);
    assert.ok(!a.includes("--insecure-ignore-tlog") && !a.includes("--insecure-ignore-sct"));
  });
});

describe("install.sh: signature fails closed", () => {
  it("good signature: installs, cosign got the pinned identity, trust root kept in ~/.dinobot", () => {
    const d = tmp();
    const cos = fakeCosign(d);
    const log = join(d, "cosign.log");
    const r = runInstall({ tarball: fakeRelease(d), home: join(d, "h"), env: { DINOBOT_COSIGN: cos, FAKE_COSIGN_LOG: log } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Signature OK/);
    assert.ok(existsSync(join(r.root, "wizard-ran")));
    const args = readFileSync(log, "utf8").split("\n");
    assert.equal(args[0], "verify-blob");
    assert.equal(args[args.indexOf("--certificate-identity-regexp") + 1], identityRegexp());
    assert.equal(args[args.indexOf("--certificate-oidc-issuer") + 1], SIGNING.issuer);
    assert.equal(args[args.indexOf("--certificate-github-workflow-repository") + 1], SIGNING.repo);
    assert.ok(args.includes(`TUF_ROOT=${join(r.root, "tools", "sigstore")}`));
  });
  it("no signature: nothing installed", () => {
    const d = tmp();
    const r = runInstall({ tarball: fakeRelease(d, { bundle: false }), home: join(d, "h"), env: { DINOBOT_COSIGN: fakeCosign(d) } });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /has no signature/);
    assert.ok(!existsSync(join(r.root, "app")) && !existsSync(join(r.root, "wizard-ran")));
    assert.ok(!existsSync(join(r.root, "download", `${PRODUCT_ID}-${OS}-${ARCH}.tar.gz`)), "tarball removed");
  });
  it("signature from someone else: nothing installed", () => {
    const d = tmp();
    const r = runInstall({ tarball: fakeRelease(d), home: join(d, "h"), env: { DINOBOT_COSIGN: fakeCosign(d), FAKE_COSIGN_RC: "1" } });
    assert.notEqual(r.status, 0);
    assert.match(r.out, new RegExp(`not from ${PRODUCT}'s release workflow \\(.*none of the expected identities`));
    assert.ok(!existsSync(join(r.root, "app")));
  });
  it("a cosign that is not there: nothing installed", () => {
    const d = tmp();
    const r = runInstall({ tarball: fakeRelease(d), home: join(d, "h"), env: { DINOBOT_COSIGN: join(d, "nope") } });
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(r.root, "app")));
  });
  it("DINOBOT_ALLOW_UNSIGNED=1 (dev builds): no signature needed, checksum still is", () => {
    const d = tmp();
    const log = join(d, "cosign.log");
    const ok = runInstall({ tarball: fakeRelease(d, { bundle: false }), home: join(d, "h"), env: { DINOBOT_ALLOW_UNSIGNED: "1", DINOBOT_COSIGN: fakeCosign(d), FAKE_COSIGN_LOG: log } });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /WARNING: signature not checked/);
    assert.ok(!existsSync(log), "cosign not run");
    const d2 = tmp();
    const no = runInstall({ tarball: fakeRelease(d2, { bundle: false, checksum: false }), home: join(d2, "h"), env: { DINOBOT_ALLOW_UNSIGNED: "1" } });
    assert.notEqual(no.status, 0);
    assert.match(no.out, /could not get the checksum/);
  });
  it("checksum is checked before the signature", () => {
    const d = tmp();
    const tar = fakeRelease(d);
    writeFileSync(`${tar}.sha256`, `${"0".repeat(64)}  x\n`);
    const log = join(d, "cosign.log");
    const r = runInstall({ tarball: tar, home: join(d, "h"), env: { DINOBOT_COSIGN: fakeCosign(d), FAKE_COSIGN_LOG: log } });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /does not match its checksum/);
    assert.ok(!existsSync(log));
  });
  it("mode off (lib/signing.json): checksum only", () => {
    const d = tmp();
    const r = runInstall({ script: stampSigning(INSTALL_SH, { ...SIGNING, mode: "off" }), tarball: fakeRelease(d, { bundle: false }), home: join(d, "h") });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /WARNING/);
  });
  it("downloads the pinned cosign once, keeps it for updates; a wrong pin is refused", () => {
    const d = tmp();
    const relDir = join(d, "cosign-release");
    mkdirSync(relDir);
    const asset = cosignAsset(P).name;
    copyFileSync(fakeCosign(d), join(relDir, asset));
    const pinned = stampSigning(INSTALL_SH, { ...SIGNING, cosign: { ...SIGNING.cosign, sha256: { ...SIGNING.cosign.sha256, [`${OS}-${ARCH}`]: sha(join(relDir, asset)) } } });
    const home = join(d, "h");
    const r = runInstall({ script: pinned, tarball: fakeRelease(d), home, env: { DINOBOT_COSIGN_BASE_URL: `file://${relDir}` } });
    assert.equal(r.status, 0, r.out);
    assert.equal(sha(join(r.root, "tools", "cosign")), sha(join(relDir, asset)));
    // Second run: the cached copy is used (the "release" is gone now).
    rmSync(relDir, { recursive: true });
    const d2 = tmp();
    const again = runInstall({ script: pinned, tarball: fakeRelease(d2), home, env: { DINOBOT_COSIGN_BASE_URL: `file://${relDir}` } });
    assert.equal(again.status, 0, again.out);
    // Wrong pin: refused, nothing installed, nothing cached.
    const d3 = tmp();
    mkdirSync(relDir);
    copyFileSync(fakeCosign(d3), join(relDir, asset));
    const bad = runInstall({ tarball: fakeRelease(d3), home: join(d3, "h"), env: { DINOBOT_COSIGN_BASE_URL: `file://${relDir}` } });
    assert.notEqual(bad.status, 0);
    assert.match(bad.out, /could not get the signature checker.*does not match its pinned checksum/);
    assert.ok(!existsSync(join(d3, "h", ".dinobot", "tools", "cosign")) && !existsSync(join(d3, "h", ".dinobot", "app")));
  });
});

describe("dinobot update: signature fails closed", () => {
  function installed(d) {
    const L = layout({ HOME: join(d, "h") });
    mkdirSync(L.app, { recursive: true });
    writeFileSync(join(L.app, "MANIFEST.json"), JSON.stringify({ built: "old" }));
    writeFileSync(L.state, JSON.stringify({ tarballSha256: "old", serviceMode: "none", port: 1 }));
    return L;
  }
  // update() prints with process.stdout.write; run it in a child so the test reporter's output is untouched.
  const quiet = async (L, opts) => {
    const code = `import { update } from ${JSON.stringify(join(HERE, "lib", "update.mjs"))};
      const r = await update(${JSON.stringify(L)}, ${JSON.stringify(opts)}); console.log("RESULT" + JSON.stringify(r));`;
    const c = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, ...opts.env } });
    const m = /RESULT(.*)/.exec(c.stdout);
    return { r: m ? JSON.parse(m[1]) : { crashed: c.stderr }, out: c.stdout + c.stderr };
  };
  it("no signature beside the tarball: nothing changed", async () => {
    const d = tmp();
    const L = installed(d);
    const { r, out } = await quiet(L, { tarball: fakeRelease(d, { bundle: false }), env: { DINOBOT_COSIGN: fakeCosign(d) } });
    assert.equal(r.ok, false);
    assert.equal(r.unsigned, true);
    assert.match(out, /signature could not be verified \(the release has no signature\); nothing changed/);
    assert.equal(JSON.parse(readFileSync(join(L.app, "MANIFEST.json"), "utf8")).built, "old");
    assert.ok(!existsSync(join(L.root, "app.new")));
  });
  it("signature rejected by cosign: nothing changed", async () => {
    const d = tmp();
    const L = installed(d);
    const { r, out } = await quiet(L, { tarball: fakeRelease(d), env: { DINOBOT_COSIGN: fakeCosign(d), FAKE_COSIGN_RC: "1" } });
    assert.equal(r.ok, false);
    assert.match(out, /none of the expected identities/);
    assert.equal(JSON.parse(readFileSync(join(L.app, "MANIFEST.json"), "utf8")).built, "old");
  });
  it("verifySignature passes the pinned identity and our TUF root", async () => {
    const d = tmp();
    const L = layout({ HOME: join(d, "h") });
    const calls = [];
    const v = await verifySignature({ file: "f", bundle: fakeRelease(d) + ".sigstore.json", cosign: "cosign", L, env: {}, deps: { run: async (c, a, o) => { calls.push([c, a, o.env.TUF_ROOT]); return { code: 0, stdout: "", stderr: "" }; } } });
    assert.equal(v.ok, true);
    assert.deepEqual(calls[0][1], verifyArgs("f", fakeRelease(d) + ".sigstore.json"));
    assert.equal(calls[0][2], join(L.root, "tools", "sigstore"));
  });
  it("ensureCosign: cached pinned copy, then PATH v3+, then a pinned download; old or wrong ones refused", async () => {
    const d = tmp();
    const L = layout({ HOME: join(d, "h") });
    const rel = join(d, "rel");
    mkdirSync(rel);
    const asset = cosignAsset(P).name;
    copyFileSync(fakeCosign(d), join(rel, asset));
    const cfg = { ...SIGNING, cosign: { ...SIGNING.cosign, sha256: { [`${OS}-${ARCH}`]: sha(join(rel, asset)) } } };
    const { run } = await import("../lib/util.mjs");
    const noCosignOnPath = { run: (c, a, o) => (c === "cosign" ? Promise.resolve({ code: 127, stdout: "", stderr: "" }) : run(c, a, o)) };
    const env = { DINOBOT_COSIGN_BASE_URL: `file://${rel}` };
    const first = await ensureCosign(L, { p: P, env, cfg, deps: noCosignOnPath });
    assert.equal(first.from, "download");
    const second = await ensureCosign(L, { p: P, env: {}, cfg, deps: noCosignOnPath });
    assert.equal(second.from, "cache");
    writeFileSync(first.path, "tampered");
    const v2 = { run: (c) => Promise.resolve(c === "cosign" ? { code: 0, stdout: "GitVersion:    v2.4.0", stderr: "" } : { code: 1, stdout: "", stderr: "offline" }) };
    const old = await ensureCosign(L, { p: P, env: {}, cfg, deps: v2 });
    assert.ok(!old.path && /could not download cosign/.test(old.why), "v2 on PATH is not used; tampered cache is not used");
    const v3 = { run: (c) => Promise.resolve({ code: 0, stdout: "GitVersion:    v3.1.4", stderr: "" }) };
    assert.equal((await ensureCosign(L, { p: P, env: {}, cfg, deps: v3 })).from, "path");
    const wrong = await ensureCosign(layout({ HOME: join(d, "h2") }), { p: P, env, cfg: { ...cfg, cosign: { ...cfg.cosign, sha256: { [`${OS}-${ARCH}`]: "0".repeat(64) } } }, deps: noCosignOnPath });
    assert.match(wrong.why, /does not match its pinned checksum/);
    assert.ok(!existsSync(join(d, "h2", ".dinobot", "tools", "cosign")));
  });
});

const REAL = process.env.COSIGN_REAL_DIR;
describe("real cosign + a real GitHub Actions keyless bundle", { skip: !REAL && "set COSIGN_REAL_DIR" }, () => {
  const gitsign = { ...SIGNING, repo: "sigstore/gitsign", workflow: ".github/workflows/release.yml", tagPattern: "v[0-9]" };
  const file = REAL && join(REAL, "gitsign_0.18.0_linux_amd64");
  const bundle = REAL && `${file}.bundle`;
  const cosign = REAL && join(REAL, "cosign-linux-amd64");
  it("the right identity verifies", async () => {
    const L = layout({ HOME: join(tmp(), "h") });
    const v = await verifySignature({ file, bundle, cosign, L, cfg: gitsign });
    assert.equal(v.ok, true, v.why);
  });
  it("our identity rejects someone else's (valid) signature", async () => {
    const L = layout({ HOME: join(tmp(), "h") });
    const v = await verifySignature({ file, bundle, cosign, L });
    assert.equal(v.ok, false);
    assert.match(v.why, /identit|SAN|repository/i);
  });
  it("a changed file is rejected", async () => {
    const d = tmp();
    const L = layout({ HOME: join(d, "h") });
    const changed = join(d, "x");
    writeFileSync(changed, Buffer.concat([readFileSync(file).subarray(0, 4096), Buffer.from("x")]));
    const v = await verifySignature({ file: changed, bundle, cosign, L, cfg: gitsign });
    assert.equal(v.ok, false);
  });
  it("install.sh with the real cosign: signature accepted (then the non-tarball fails to unpack)", () => {
    const d = tmp();
    const name = `${PRODUCT_ID}-${OS}-${ARCH}.tar.gz`;
    const tar = join(d, name);
    copyFileSync(file, tar);
    copyFileSync(bundle, `${tar}.sigstore.json`);
    writeFileSync(`${tar}.sha256`, `${sha(tar)}  ${name}\n`);
    const ok = runInstall({ script: stampSigning(INSTALL_SH, gitsign), tarball: tar, home: join(d, "h"), env: { DINOBOT_COSIGN: cosign } });
    assert.match(ok.out, /Signature OK/, ok.out);
    assert.match(ok.out, /could not unpack/);
    const d2 = tmp();
    const tar2 = join(d2, name);
    copyFileSync(tar, tar2); copyFileSync(`${tar}.sigstore.json`, `${tar2}.sigstore.json`); copyFileSync(`${tar}.sha256`, `${tar2}.sha256`);
    const no = runInstall({ tarball: tar2, home: join(d2, "h"), env: { DINOBOT_COSIGN: cosign } });
    assert.notEqual(no.status, 0);
    assert.match(no.out, /not from .*release workflow/, no.out);
    assert.doesNotMatch(no.out, /Signature OK/);
  });
});

