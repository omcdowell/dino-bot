// `dinobot update`: compare the release's checksum with the installed one (up to date: nothing is
// downloaded), else fetch the newest tarball (progress line; resumes after a dropped connection),
// verify it, swap it in, run the NEW version's post-update step (lib/post-update.mjs), restart the
// daemon, and roll back if that step fails or the new daemon does not become ready. Config,
// password, bots, memories and sign-ins are untouched (they live outside ~/.<id>/app). The herdr
// server is not restarted (that would end running workers): a new herdr binary is used from the
// next `stop`/`start` or reboot.
//
//   dinobot update [--check] [--tarball FILE | --url URL]
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { probeHostFor, readEnvFile } from "./config.mjs";
import { desktopAppHint, macDesktopAppVersion } from "./desktop-app.mjs";
import { ensurePathLink } from "./path-link.mjs";
import { describeDrift, pairingDrift, pairingIdentity } from "./pairing-identity.mjs";
import { platform } from "./detect.mjs";
import { postUpdate } from "./post-update.mjs";
import { waitForReady } from "./ready.mjs";
import { ensureCosign, SIGNING, signingRequired, verifySignature } from "./signature.mjs";
import { startServices } from "./service.mjs";
import { makeSay, progressBar, termSize, tuiMode } from "./tui.mjs";
import { DOWNLOAD_BASE_URL, fmt, PRODUCT, PRODUCT_ID, readJson, RELEASE_REPO, run, Timer, VERSION, writeJson } from "./util.mjs";

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

/** Total bytes from a curl -D file: the last response's Content-Range total (resumed) or Content-Length. */
export function headerTotal(text) {
  const last = String(text ?? "").split(/^(?=HTTP\/)/m).pop();
  const range = /^content-range:\s*bytes [^/]*\/(\d+)/im.exec(last);
  const len = /^content-length:\s*(\d+)/im.exec(last);
  return Number(range?.[1] ?? len?.[1] ?? 0) || null;
}

/** "Downloading  [#####---------------]  25%  32/128 MB" (no total: "Downloading  32 MB"). */
export function progressLine(got, total) {
  const mb = (n) => Math.floor(n / 1048576);
  if (!total) return `Downloading  ${mb(got)} MB`;
  const pc = Math.min(100, Math.floor((got * 100) / total));
  const h = Math.floor(pc / 5);
  return `Downloading  [${"#".repeat(h)}${"-".repeat(20 - h)}] ${String(pc).padStart(3)}%  ${mb(got)}/${mb(total)} MB`;
}

/** Progress of `dest` while it grows: one redrawn line at a terminal, else a line each quarter. -> stop(). */
function progressTicker(dest, hdr, out = process.stdout) {
  const tty = Boolean(out.isTTY);
  let q = 25;
  let shown = false;
  const tick = () => {
    let got = 0;
    try {
      got = statSync(dest).size;
    } catch {}
    let total = null;
    try {
      total = headerTotal(readFileSync(hdr, "utf8"));
    } catch {}
    if (tty && tuiMode(out).rich) {
      out.write(`\r\u001b[K${progressBar(got, total, termSize(out).cols, tuiMode(out).color)}`);
      shown = true;
    } else if (tty) {
      out.write(`\r${progressLine(got, total)}   `);
      shown = true;
    } else if (total && (got * 100) / total >= q && got < total) {
      out.write(`${progressLine(got, total)}\n`);
      q = (Math.floor((got * 100) / total / 25) + 1) * 25;
    }
  };
  const timer = setInterval(tick, 500);
  return () => {
    clearInterval(timer);
    if (shown) {
      tick();
      out.write("\n");
    }
  };
}

/**
 * Downloads `url` to `dest` (curl). Flaky networks (hotel Wi-Fi, dbnet report): short connect
 * timeout growing on each try, a stalled transfer (<1 KB/s for 30 s) dropped, up to 6 tries, each
 * resuming `dest` where the last stopped; a refused resume starts again from 0 once. A `dest` left
 * by an earlier run is resumed too. `progress`: show a progress line.
 */
async function download(url, dest, { progress = false } = {}) {
  if (await hasCurl()) {
    const hdr = `${dest}.hdr`;
    const stop = progress ? progressTicker(dest, hdr) : () => {};
    let fresh = false;
    try {
      for (let attempt = 1; ; attempt++) {
        const resume = existsSync(dest) && statSync(dest).size > 0;
        const r = await run("curl", ["-fsSL", ...curlSafe(url), "--connect-timeout", String(attempt * 5), "--speed-limit", "1024", "--speed-time", "30", ...(resume ? ["-C", "-"] : []), "-D", hdr, "-o", dest, url], { timeout: 30 * 60_000 });
        if (r.code === 0) return;
        const why = r.stderr.trim().split("\n").pop() || `curl exit ${r.code}`;
        if ([22, 33, 36].includes(r.code)) {
          if (!resume || fresh) throw new Error(why);
          fresh = true;
          rmSync(dest, { force: true });
        } else if (attempt >= 6) throw new Error(why);
        await new Promise((res) => setTimeout(res, 1000));
      }
    } finally {
      stop();
      rmSync(hdr, { force: true });
    }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}

/** The text at url, or null. A 404 sets notFound.at (an unpublished release says so plainly). */
async function fetchText(url, notFound = {}) {
  if (await hasCurl()) {
    const r = await run("curl", ["-fsSL", ...curlSafe(url), "--connect-timeout", "5", "--retry", "3", "--retry-delay", "1", "--max-time", "15", url], { timeout: 90_000 });
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

// Plain lines, or at a terminal the rich look (tui.mjs: readable column, ~ paths, ✓ for done).
const say = makeSay();
const RICH = tuiMode().rich;

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

/** Up to date: `update` keeps (or repairs) ~/.local/bin/dinobot; says so only when something needs the user. */
function keepPathLink(L, env) {
  const r = ensurePathLink(L, { env });
  if (r.status === "created" || r.status === "repaired") say(`Linked ${r.link} -> ${r.target}.`);
  if (r.note) say(RICH ? r.shortNote : r.note);
  return r;
}

/** The version in an app folder (its product.json), or null. */
const appVersion = (app) => readJson(join(app, "installer", "lib", "product.json"), {})?.version ?? null;

/**
 * The post-update step with the code now in L.app: the new version's own (a child process with its
 * Node), or this process's for an app without it (an older release, or putting one back).
 */
async function runPostUpdate(L, env, { inProcess = false, quiet = false } = {}) {
  if (inProcess || !existsSync(join(L.app, "installer", "lib", "post-update.mjs"))) {
    return postUpdate(L, { env, say: quiet ? () => {} : say }).catch((e) => ({ ok: false, why: e.message }));
  }
  const code = await new Promise((resolve) => {
    const child = spawn(L.node, ["--experimental-transform-types", "--no-warnings", join(L.app, "installer", "lib", "cli.mjs"), "post-update"], {
      env: { ...env, HOME: L.home, DINOBOT_HOME: L.root },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", () => resolve(127));
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });
  return code === 0 ? { ok: true } : { ok: false, why: `exit ${code}` };
}

/**
 * `deps` (tests): startServices, waitForReady, desktopAppVersion. Returns {ok, changed?, rolledBack?, ...}.
 */
export async function update(L, { check = false, tarball, url, env = process.env } = {}, deps = {}) {
  const start = deps.startServices ?? startServices;
  const ready_ = deps.waitForReady ?? waitForReady;
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
  const oldVersion = appVersion(L.app) ?? VERSION;
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
    else if (wantSha === state.tarballSha256) say(`${PRODUCT} ${oldVersion} is up to date.`, "ok");
    else say(`An update is available. Run: ${PRODUCT_ID} update`);
    return { ok: Boolean(wantSha), available: Boolean(wantSha && wantSha !== state.tarballSha256) };
  }
  // Up to date: the release's checksum is the installed one, so nothing is downloaded (this used
  // to fetch the whole 100-140 MB tarball first, minutes on slow Wi-Fi, to say the same).
  if (wantSha && wantSha === state.tarballSha256) {
    say(`${PRODUCT} ${oldVersion} is already up to date.`, "ok");
    keepPathLink(L, env);
    return { ok: true, changed: false };
  }

  if (!wantSha && env.DINOBOT_ALLOW_UNVERIFIED !== "1") {
    say(`Could not get the checksum (${source.src}.sha256), so the update cannot be verified. Nothing changed.`);
    return { ok: false };
  }

  // 1. Download (or copy) and verify. A .part left by a run that lost its network is resumed; if
  // it then fails the checksum, it was of an older release: once more from the start.
  const dl = join(L.root, "download");
  mkdirSync(dl, { recursive: true });
  const zst = /\.zst$/.test(source.src);
  const file = join(dl, tarballName(platform(), zst ? "zst" : "gz"));
  if (RICH) {
    say(`Updating ${PRODUCT} ${oldVersion}`, "head");
    say("");
  }
  else say(`${PRODUCT} ${oldVersion}: downloading the update (${basename(source.src)})...`);
  const fetchIt = async () => {
    if (source.kind === "url") {
      await download(source.src, `${file}.part`, { progress: true });
      renameSync(`${file}.part`, file);
    } else {
      await pipeline(createReadStream(source.src), createWriteStream(file));
    }
  };
  let resumed = source.kind === "url" && existsSync(`${file}.part`);
  let gotSha;
  for (;;) {
    try {
      await fetchIt();
    } catch (e) {
      if (source.kind !== "url") {
        rmSync(file, { force: true });
        say(`Could not copy ${source.src} (${e.code ?? e.message}); nothing changed.`);
      } else say(`Download stopped (${e.cause?.code ?? e.message}); nothing changed. Run \`${PRODUCT_ID} update\` again: it carries on where it stopped.`);
      return { ok: false };
    }
    gotSha = await sha256File(file);
    if (!wantSha || wantSha === gotSha) break; // (no wantSha only with DINOBOT_ALLOW_UNVERIFIED=1)
    rmSync(file, { force: true });
    if (resumed) {
      resumed = false;
      say("The part downloaded by an earlier try was of another release; downloading again from the start.");
      continue;
    }
    say(`Checksum mismatch (want ${wantSha.slice(0, 12)}, got ${gotSha.slice(0, 12)}); nothing changed.`);
    return { ok: false };
  }
  if (gotSha === state.tarballSha256) {
    rmSync(file, { force: true });
    say(`${PRODUCT} ${oldVersion} is already up to date.`, "ok");
    keepPathLink(L, env);
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
  } else if (SIGNING.mode !== "off") say(RICH ? "! signature not checked (development build: DINOBOT_ALLOW_UNSIGNED)" : "WARNING: signature not checked (DINOBOT_ALLOW_UNSIGNED / DINOBOT_ALLOW_UNVERIFIED).", RICH ? "dim" : null);
  if (RICH) say(`Downloaded and checked${SIGNING.mode !== "off" && signingRequired(env) ? " (checksum and signature)" : ""}.`, "ok");
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
  const newVersion = appVersion(next) ?? "?";
  const herdrChanged = existsSync(join(L.app, "herdr", "herdr")) && existsSync(join(next, "herdr", "herdr")) && (await sha256File(join(L.app, "herdr", "herdr"))) !== (await sha256File(join(next, "herdr", "herdr")));
  timer.mark("unpack + check");

  // 3. Swap, then the NEW version's post-update step (wrappers, service files, link: same paths),
  // restart the daemon only. putBack(): the previous app and its files again (this process's code
  // is the previous version's, so it runs its own post-update step in-process).
  const old = join(L.root, "app.old");
  rmSync(old, { recursive: true, force: true });
  renameSync(L.app, old);
  renameSync(next, L.app);
  const putBack = async () => {
    rmSync(next, { recursive: true, force: true });
    renameSync(L.app, next);
    renameSync(old, L.app);
    await runPostUpdate(L, env, { inProcess: true, quiet: true });
    rmSync(next, { recursive: true, force: true });
  };
  const hook = await runPostUpdate(L, env);
  if (!hook.ok) {
    say(`The new version's setup step failed (${hook.why}); putting the previous version back. The daemon was not restarted; nothing changed.`);
    await putBack();
    return { ok: false, rolledBack: true, postUpdate: hook.why };
  }
  timer.mark("post-update (new version)");
  const driftBeforeRestart = pairingDrift(identityBefore, pairingIdentity({ paseoHome: L.paseoHome, envFile: L.envFile }));
  if (driftBeforeRestart.length) {
    say(`STOPPED before the restart: the update would change the ${describeDrift(driftBeforeRestart)}, and the phone would have to pair again. Putting the previous version back; the daemon was not restarted.`);
    await putBack();
    return { ok: false, pairingDrift: driftBeforeRestart };
  }
  await start(L, state.serviceMode, { herdr: false, restart: true });
  const denv = readEnvFile(L.envFile);
  const ready = await ready_({ port: state.port, host: probeHostFor(denv.PASEO_LISTEN), timeoutMs: 90_000 });
  timer.mark("restart daemon + ready");

  if (!ready.ready) {
    // 4. Roll back.
    say("The new version did not start; going back to the previous one.");
    await putBack();
    await start(L, state.serviceMode, { herdr: false, restart: true });
    const back = await ready_({ port: state.port, host: probeHostFor(denv.PASEO_LISTEN), timeoutMs: 90_000 });
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
  const builds = oldVersion === newVersion ? ` (build ${oldManifest.built ?? "?"} -> ${newManifest.built ?? "?"})` : "";
  if (RICH) say("");
  say(`Updated ${PRODUCT} ${oldVersion} -> ${newVersion}${builds} in ${fmt(timer.elapsedMs)}. Your phone stays paired; nothing to do there.`, "ok");
  const desktopHint = desktopAppHint({
    product: PRODUCT,
    desktopVersion: (deps.desktopAppVersion ?? macDesktopAppVersion)({ product: PRODUCT, home: L.home }),
    newVersion,
    releaseRepo: RELEASE_REPO,
  });
  if (desktopHint) say(desktopHint);
  if (herdrChanged) say(`herdr was updated too; running workers keep the old one until \`${PRODUCT_ID} stop && ${PRODUCT_ID} start\` (that ends running workers).`);
  say(`The previous version is kept in ${old} until the next update.`, "dim");
  return { ok: true, changed: true, steps: timer.steps, ...(driftAfterRestart.length ? { pairingDrift: driftAfterRestart } : {}) };
}
