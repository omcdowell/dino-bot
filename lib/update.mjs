// `dinobot update`: fetch the newest tarball, swap it in, restart the daemon, roll back if the new
// one does not become ready. Config, password, bots, memories and sign-ins are untouched (they live
// outside ~/.<id>/app). The herdr server is not restarted (that would end running workers): a new
// herdr binary is used from the next `stop`/`start` or reboot.
//
//   dinobot update [--check] [--tarball FILE | --url URL]
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { probeHostFor, readEnvFile, refreshOptchatCommand, writePiSetup, writeWrappers } from "./config.mjs";
import { describeDrift, pairingDrift, pairingIdentity } from "./pairing-identity.mjs";
import { platform } from "./detect.mjs";
import { waitForReady } from "./ready.mjs";
import { ensureCosign, SIGNING, signingRequired, verifySignature } from "./signature.mjs";
import { startServices, writeServices } from "./service.mjs";
import { DOWNLOAD_BASE_URL, fmt, PRODUCT, PRODUCT_ID, readJson, run, Timer, writeJson } from "./util.mjs";

/** The release asset: .tar.gz, or .tar.zst (same tree, smaller; Node unpacks it, no zstd needed). */
export function tarballName(p = platform(), format = "gz") {
  return `${PRODUCT_ID}-${p.os}-${p.arch}.tar.${format === "zst" ? "zst" : "gz"}`;
}

/**
 * Where to get the tarball: flag, env, then the host the install came from, then the release.
 * `format` (state.tarballFormat: what install.sh downloaded) picks .tar.zst or .tar.gz from a release.
 */
export function updateSource({ tarball, url, env = process.env, p = platform(), savedBaseUrl = null, format = "gz" }) {
  if (tarball) return { kind: "file", src: tarball };
  if (url) return { kind: "url", src: url };
  if (env.DINOBOT_TARBALL) return { kind: /^https?:/.test(env.DINOBOT_TARBALL) ? "url" : "file", src: env.DINOBOT_TARBALL };
  // The host the install came from (DINOBOT_BASE_URL at install time); file:// is a local stand-in.
  const base = env.DINOBOT_BASE_URL || savedBaseUrl;
  if (base) {
    const src = `${base.replace(/\/$/, "")}/${tarballName(p, format)}`;
    return src.startsWith("file://") ? { kind: "file", src: src.slice("file://".length) } : { kind: "url", src };
  }
  // The GitHub release: the latest, or DINOBOT_RELEASE=<tag>.
  const rel = env.DINOBOT_RELEASE && env.DINOBOT_RELEASE !== "latest" ? DOWNLOAD_BASE_URL.replace(/\/latest\/download\/?$/, `/download/${env.DINOBOT_RELEASE}`) : DOWNLOAD_BASE_URL;
  return { kind: "url", src: `${rel.replace(/\/$/, "")}/${tarballName(p, format)}` };
}

/** Why a download URL is refused: plain http is allowed only to this computer (tests), as in install.sh. */
export function insecureUrlProblem(url) {
  if (/^https:\/\//i.test(url)) return null;
  if (/^http:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(url)) return null;
  return `Refusing ${url}: updates download over https only.`;
}
/** curl flags: https only, TLS 1.2+, no downgrade on redirects (plain http only for loopback tests). */
const curlSafe = (url) => (/^https:/i.test(url) ? ["--proto", "=https", "--tlsv1.2"] : []);

async function sha256File(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

// curl first (as install.sh): Node 24's fetch can die on an uncatchable internal assertion when
// a server closes the connection early (seen with python's http.server).
async function hasCurl() {
  return (await run("curl", ["--version"])).code === 0;
}

async function download(url, dest) {
  if (await hasCurl()) {
    const r = await run("curl", ["-fsSL", ...curlSafe(url), "--retry", "2", "-o", dest, url], { timeout: 30 * 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `curl exit ${r.code}`);
    return;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}

/** The text at url, or null. A 404 sets notFound.at (an unpublished release says so plainly). */
async function fetchText(url, notFound = {}) {
  if (await hasCurl()) {
    const r = await run("curl", ["-fsSL", ...curlSafe(url), "--max-time", "15", url], { timeout: 20_000 });
    if (r.code !== 0 && /error: 404\b/.test(r.stderr)) notFound.at = url;
    return r.code === 0 ? r.stdout.trim() : null;
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) notFound.at = url;
    return r.ok ? (await r.text()).trim() : null;
  } catch {
    return null;
  }
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

const say = (s = "") => process.stdout.write(`${s}\n`);

/** Unpacks a .tar.zst with Node's own zstd (no zstd program needed) into `dest`. {code, stderr} like run(). */
export async function untarZst(file, dest) {
  const tar = spawn("tar", ["-xmf", "-", "-C", dest, "--strip-components=1"], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => tar.on("close", (code) => resolve(code ?? 1)));
  try {
    await pipeline(createReadStream(file), createZstdDecompress(), tar.stdin);
  } catch (e) {
    tar.kill();
    await exited;
    return { code: 1, stderr: `zstd: ${e.message}` };
  }
  return { code: await exited, stderr };
}

/** Fetch <source>.sigstore.json next to the download and check it. {ok} or {ok:false, why}. */
async function checkSignature(L, source, file, env) {
  const bundle = `${file}${SIGNING.bundleSuffix}`;
  rmSync(bundle, { force: true });
  try {
    if (source.kind === "url") await download(`${source.src}${SIGNING.bundleSuffix}`, bundle);
    else if (existsSync(`${source.src}${SIGNING.bundleSuffix}`)) await pipeline(createReadStream(`${source.src}${SIGNING.bundleSuffix}`), createWriteStream(bundle));
  } catch {
    rmSync(bundle, { force: true }); // missing: refused below
  }
  try {
    const cosign = await ensureCosign(L, { p: platform(), env });
    if (!cosign.path) return { ok: false, why: cosign.why };
    return await verifySignature({ file, bundle, cosign: cosign.path, L, env });
  } finally {
    rmSync(bundle, { force: true });
  }
}

export async function update(L, { check = false, tarball, url, env = process.env } = {}) {
  const state = readJson(L.state);
  if (!state) {
    say(`Not set up yet: run the ${PRODUCT} installer first.`);
    return { ok: false };
  }
  const timer = new Timer();
  // The phone stays paired only if the daemon keeps its key, server id, address, password and
  // session-token key (RU1): taken now, checked before the restart and again once it is up.
  const identityBefore = pairingIdentity({ paseoHome: L.paseoHome, envFile: L.envFile });
  const format = state.tarballFormat === "zst" ? "zst" : "gz";
  let source = updateSource({ tarball, url, env, savedBaseUrl: state.downloadBaseUrl, format });
  const oldManifest = readJson(join(L.app, "MANIFEST.json"), {});
  const insecure = source.kind === "url" ? insecureUrlProblem(source.src) : null;
  if (insecure) {
    say(insecure);
    return { ok: false };
  }
  // Fail closed: the checksum is required (URL: <url>.sha256 from the same release; file: a .sha256
  // beside it). DINOBOT_ALLOW_UNVERIFIED=1 is for local development builds only.
  let notFound = {};
  const readSha = (s) => (s.kind === "url" ? fetchText(`${s.src}.sha256`, notFound) : readTextOrNull(`${s.src}.sha256`));
  let shaText = await readSha(source);
  // A release without the .tar.zst (older ones): its .tar.gz.
  if (!shaText && format === "zst" && !tarball && !url && !env.DINOBOT_TARBALL) {
    source = updateSource({ tarball, url, env, savedBaseUrl: state.downloadBaseUrl, format: "gz" });
    notFound = {};
    shaText = await readSha(source);
  }
  const wantSha = shaText?.split(/\s+/)[0] || null;
  if (!wantSha && notFound.at && env.DINOBOT_ALLOW_UNVERIFIED !== "1") {
    say(`No release has been published yet at ${dirname(source.src)} (or it has no ${basename(source.src)} for this computer; HTTP 404). Nothing changed.`);
    return { ok: false, noRelease: true };
  }

  if (check) {
    if (!wantSha) say(`Could not read ${source.src}.sha256; cannot tell if an update is out.`);
    else if (wantSha === state.tarballSha256) say(`${PRODUCT} is up to date (build ${oldManifest.built ?? "?"}).`);
    else say(`An update is available. Run: ${PRODUCT_ID} update`);
    return { ok: Boolean(wantSha), available: Boolean(wantSha && wantSha !== state.tarballSha256) };
  }

  if (!wantSha && env.DINOBOT_ALLOW_UNVERIFIED !== "1") {
    say(`Could not get the checksum (${source.src}.sha256), so the update cannot be verified. Nothing changed.`);
    return { ok: false };
  }

  // 1. Download (or copy) and verify.
  const dl = join(L.root, "download");
  mkdirSync(dl, { recursive: true });
  const zst = /\.zst$/.test(source.src);
  const file = join(dl, tarballName(platform(), zst ? "zst" : "gz"));
  say(`Downloading ${source.src}`);
  try {
    if (source.kind === "url") {
      await download(source.src, `${file}.part`);
      renameSync(`${file}.part`, file);
    } else {
      await pipeline(createReadStream(source.src), createWriteStream(file));
    }
  } catch (e) {
    rmSync(`${file}.part`, { force: true });
    say(`Download failed (${e.cause?.code ?? e.message}); nothing changed. Check your connection, or pass --tarball FILE.`);
    return { ok: false };
  }
  const gotSha = await sha256File(file);
  if (wantSha && wantSha !== gotSha) { // (no wantSha only with DINOBOT_ALLOW_UNVERIFIED=1)
    rmSync(file, { force: true });
    say(`Checksum mismatch (want ${wantSha.slice(0, 12)}, got ${gotSha.slice(0, 12)}); nothing changed.`);
    return { ok: false };
  }
  if (gotSha === state.tarballSha256) {
    rmSync(file, { force: true });
    say(`${PRODUCT} is already up to date.`);
    return { ok: true, changed: false };
  }
  // 1b. Signature, fail closed (lib/signing.json): <tarball>.sigstore.json from the same release,
  // made by our release workflow in GitHub Actions, checked with the pinned cosign.
  if (signingRequired(env)) {
    const v = await checkSignature(L, source, file, env);
    if (!v.ok) {
      rmSync(file, { force: true });
      say(`The update's signature could not be verified (${v.why}); nothing changed.`);
      return { ok: false, unsigned: true };
    }
  } else if (SIGNING.mode !== "off") say("WARNING: signature not checked (DINOBOT_ALLOW_UNSIGNED / DINOBOT_ALLOW_UNVERIFIED).");
  timer.mark("download + verify");

  // 2. Unpack next to the current app and check it runs.
  const next = join(L.root, "app.new");
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const un = zst ? await untarZst(file, next) : await run("tar", ["-xzf", file, "-C", next, "--strip-components=1"], { timeout: 300_000 });
  if (un.code !== 0 || !existsSync(join(next, "node", "bin", "node"))) {
    rmSync(next, { recursive: true, force: true });
    say(`Could not unpack the update (${un.stderr.trim().slice(0, 200) || "no Node inside"}); nothing changed.`);
    return { ok: false };
  }
  const probe = await run(join(next, "node", "bin", "node"), ["-v"]);
  if (probe.code !== 0) {
    rmSync(next, { recursive: true, force: true });
    say(`The update's Node does not run on this computer; nothing changed.`);
    return { ok: false };
  }
  const newManifest = readJson(join(next, "MANIFEST.json"), {});
  const herdrChanged = existsSync(join(L.app, "herdr", "herdr")) && existsSync(join(next, "herdr", "herdr")) && (await sha256File(join(L.app, "herdr", "herdr"))) !== (await sha256File(join(next, "herdr", "herdr")));
  timer.mark("unpack + check");

  // 3. Swap, rewrite wrappers and service files (paths are the same), restart the daemon only.
  const old = join(L.root, "app.old");
  rmSync(old, { recursive: true, force: true });
  renameSync(L.app, old);
  renameSync(next, L.app);
  writeWrappers(L);
  writePiSetup(L); // new settings (e.g. npmCommand) for an existing pi dir; user changes are kept
  refreshOptchatCommand(L); // bot-only extensions and skills the new app bundles
  writeServices(L, state.serviceMode);
  const driftBeforeRestart = pairingDrift(identityBefore, pairingIdentity({ paseoHome: L.paseoHome, envFile: L.envFile }));
  if (driftBeforeRestart.length) {
    say(`STOPPED before the restart: the update would change the ${describeDrift(driftBeforeRestart)}, and the phone would have to pair again. Putting the previous version back; the daemon was not restarted.`);
    rmSync(next, { recursive: true, force: true });
    renameSync(L.app, next);
    renameSync(old, L.app);
    writeWrappers(L);
    writePiSetup(L);
    refreshOptchatCommand(L);
    writeServices(L, state.serviceMode);
    rmSync(next, { recursive: true, force: true });
    return { ok: false, pairingDrift: driftBeforeRestart };
  }
  await startServices(L, state.serviceMode, { herdr: false, restart: true });
  const denv = readEnvFile(L.envFile);
  const ready = await waitForReady({ port: state.port, host: probeHostFor(denv.PASEO_LISTEN), timeoutMs: 90_000 });
  timer.mark("restart daemon + ready");

  if (!ready.ready) {
    // 4. Roll back.
    say("The new version did not start; going back to the previous one.");
    rmSync(next, { recursive: true, force: true });
    renameSync(L.app, next);
    renameSync(old, L.app);
    writeWrappers(L);
    writePiSetup(L); // new settings (e.g. npmCommand) for an existing pi dir; user changes are kept
    refreshOptchatCommand(L);
    writeServices(L, state.serviceMode);
    await startServices(L, state.serviceMode, { herdr: false, restart: true });
    const back = await waitForReady({ port: state.port, host: probeHostFor(denv.PASEO_LISTEN), timeoutMs: 90_000 });
    rmSync(next, { recursive: true, force: true });
    timer.mark("rollback");
    say(back.ready ? "Rolled back; the previous version is running." : `Rolled back, but the daemon is not answering: run \`${PRODUCT_ID} doctor\`.`);
    return { ok: false, rolledBack: true };
  }
  const driftAfterRestart = pairingDrift(identityBefore, pairingIdentity({ paseoHome: L.paseoHome, envFile: L.envFile }));
  if (driftAfterRestart.length) {
    // Never expected (the daemon only creates these when missing); say it loudly, keep the files.
    say(`WARNING: after the restart the ${describeDrift(driftAfterRestart)} changed; the phone may have to pair again. Run \`${PRODUCT_ID} doctor\` and keep ${old} for a rollback.`);
  }
  rmSync(file, { force: true });
  writeJson(L.state, { ...readJson(L.state), tarballSha256: gotSha, tarballFormat: zst ? "zst" : "gz", updatedAt: new Date().toISOString(), lastUpdate: timer.steps }, 0o600);
  say(`Updated ${PRODUCT}: build ${oldManifest.built ?? "?"} -> ${newManifest.built ?? "?"} (installer ${oldManifest.installer ?? "?"} -> ${newManifest.installer ?? "?"}) in ${fmt(timer.elapsedMs)}.`);
  if (herdrChanged) say(`herdr was updated too; running workers keep the old one until \`${PRODUCT_ID} stop && ${PRODUCT_ID} start\` (that ends running workers).`);
  say(`The previous version is kept in ${old} until the next update.`);
  return { ok: true, changed: true, steps: timer.steps, ...(driftAfterRestart.length ? { pairingDrift: driftAfterRestart } : {}) };
}
