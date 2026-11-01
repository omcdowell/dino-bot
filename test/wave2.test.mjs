// Unit tests for wave 2: readiness probe, listen policy, short herdr sockets, doctor, update source,
// product names. node --test test/wave2.test.mjs  (temp dirs under ./.test-tmp2, never /tmp)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { gitGuardWrapper, listenPlan, probeHostFor } from "../lib/config.mjs";
import { detectTailscale } from "../lib/detect.mjs";
import { DIRECT_OFFER_BASE_URL } from "../lib/offer.mjs";
import { phoneSafeMethod } from "../lib/signin.mjs";
import { tailscaleSteps } from "../lib/tailscale.mjs";
import * as fsMod from "node:fs";
const require_fs = () => fsMod;
import { checkListenScope, formatChecks, restartHint } from "../lib/doctor.mjs";
import { herdrSocketDir, herdrWrapper, socketPathFits } from "../lib/herdr.mjs";
import { offerEndpoints } from "../lib/offer.mjs";
import { isReadyStatus, probeWs, waitForReady } from "../lib/ready.mjs";
import { insecureUrlProblem, updateSource } from "../lib/update.mjs";
import { DOWNLOAD_BASE_URL, LINK_SCHEME, PRODUCT, PRODUCT_ID, BUNDLE_ID } from "../lib/util.mjs";

const HERE = join(import.meta.dirname, "..");
const TMP = join(HERE, ".test-tmp2");
mkdirSync(TMP, { recursive: true });
const tmp = () => mkdtempSync(join(TMP, "t-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const TS = { running: true, dnsName: "box.tail1.ts.net", ip: "100.64.0.7" };

describe("product names (one place)", () => {
  const p = JSON.parse(readFileSync(join(HERE, "lib", "product.json"), "utf8"));
  it("DinoBot display name, placeholder bundle id", () => {
    assert.equal(PRODUCT, "DinoBot");
    assert.equal(BUNDLE_ID, "com.dinobot.test");
    assert.equal(PRODUCT_ID, p.id);
  });
  it("install.sh's stamped copies match lib/product.json", () => {
    const sh = readFileSync(join(HERE, "install.sh"), "utf8");
    assert.match(sh, new RegExp(`^PRODUCT_NAME="${p.name}"`, "m"));
    assert.match(sh, new RegExp(`^DEFAULT_BASE_URL="${p.downloadBaseUrl}"`, "m"));
    assert.equal(DOWNLOAD_BASE_URL, p.downloadBaseUrl);
  });
  it("no other file hard-codes a display name", () => {
    const out = execFileSync("git", ["grep", "--untracked", "-n", "-I", "-e", "Botswain", "-e", "DinoBot", "--", "lib", "build", "install.sh"], { cwd: HERE, encoding: "utf8" }).trim().split("\n");
    // Comments do not reach users; code and strings must take the name from product.json.
    const bad = out.filter((l) => !l.startsWith("lib/product.json") && !/^install\.sh:\d+:PRODUCT_NAME=/.test(l) && !/^[^:]+:\d+:\s*(\/\/|\*|\/\*\*|#)/.test(l));
    assert.deepEqual(bad, []);
  });
});

describe("Tailscale only (owner decision, 27 Oct)", () => {
  it("listens on the tailnet address; no plan at all without Tailscale (no 0.0.0.0 fallback)", () => {
    assert.deepEqual(listenPlan({ tailscale: TS, port: 6767 }), { listen: "100.64.0.7:6767", probeHost: "100.64.0.7" });
    assert.equal(listenPlan({ tailscale: { running: false }, port: 6767 }), null);
    assert.equal(listenPlan({ tailscale: { running: true, ip: null }, port: 6767 }), null);
  });
  it("no code path listens on every interface", () => {
    const src = ["config.mjs", "cli.mjs", "service.mjs", "update.mjs"].map((f) => readFileSync(join(HERE, "lib", f), "utf8")).join("\n");
    assert.doesNotMatch(src, /0\.0\.0\.0:\$\{/);
  });
  it("stops with plain steps when Tailscale is missing, off or logged out", () => {
    const mac = tailscaleSteps({ installed: false, state: "NotInstalled" }, { os: "darwin", rerun: "X setup" });
    assert.match(mac.join("\n"), /apps\.apple\.com\/app\/tailscale/);
    assert.match(mac.join("\n"), /iPhone/);
    assert.ok(mac.includes("Then finish setup:   X setup"));
    assert.ok(mac.some((l) => /^3\. On your iPhone/.test(l)));
    assert.match(tailscaleSteps({ installed: false }, { os: "linux" }).join("\n"), /tailscale\.com\/install\.sh/);
    assert.match(tailscaleSteps({ installed: true, state: "Stopped" }, { os: "darwin" }).join("\n"), /menu bar, then Connect/);
    assert.match(tailscaleSteps({ installed: true, state: "NeedsLogin" }, { os: "linux" }).join("\n"), /tailscale up/);
    assert.match(tailscaleSteps({ installed: true, state: "NeedsMachineAuth" }, { os: "linux" }).join("\n"), /admin\/machines/);
  });
  it("probe host from PASEO_LISTEN", () => {
    assert.equal(probeHostFor("0.0.0.0:6767"), "127.0.0.1");
    assert.equal(probeHostFor("100.64.0.7:6767"), "100.64.0.7");
  });
  it("doctor: FAIL for an old all-networks bind, no Tailscale, or a changed tailnet IP", () => {
    assert.equal(checkListenScope({ listen: "0.0.0.0:6767", tailscale: TS }).status, "FAIL");
    assert.equal(checkListenScope({ listen: "100.64.0.7:6767", tailscale: { running: false } }).status, "FAIL");
    assert.equal(checkListenScope({ listen: "100.64.0.7:6767", tailscale: { ...TS, ip: "100.64.0.9" } }).status, "FAIL");
    assert.equal(checkListenScope({ listen: "100.64.0.7:6767", tailscale: TS }).status, "ok");
  });
  it("detects a stopped Tailscale from a fake CLI, and a missing one", async () => {
    const dir = tmp();
    const fake = join(dir, "tailscale");
    writeFileSync(fake, '#!/bin/sh\necho \'{"BackendState":"Stopped","Self":{}}\'\nexit 1\n');
    chmodSync(fake, 0o755);
    const off = await detectTailscale({ env: { DINOBOT_TAILSCALE_BIN: fake } });
    assert.equal(off.installed, true);
    assert.equal(off.state, "Stopped");
    assert.equal(off.running, false);
    const none = await detectTailscale({ env: { DINOBOT_TAILSCALE_BIN: join(dir, "nope") } });
    assert.equal(none.installed, false);
  });
});

describe("pairing link scheme", () => {
  it("is the app's scheme, derived from the name like release-flavour.js", () => {
    assert.equal(LINK_SCHEME, "dinobot");
    assert.ok(DIRECT_OFFER_BASE_URL === "dinobot://pair");
  });
  it("matches rel-app2's release-flavour.js when that branch is here", () => {
    let src;
    try {
      src = execFileSync("git", ["-C", join(process.env.HOME, "code", "paseo"), "show", "release/app-main:packages/app/release-flavour.js"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // not on this machine
    }
    const name = /PUBLIC_APP_NAME\s*=\s*"([^"]+)"/.exec(src)?.[1];
    assert.equal(name, PRODUCT);
  });
});

describe("sign-in and macOS git", () => {
  it("picks device code / copy code, never the localhost browser login", () => {
    assert.equal(phoneSafeMethod([{ id: "browser", label: "Browser login (default)" }, { id: "device_code", label: "Device code login (headless)" }]), "device_code");
    assert.equal(phoneSafeMethod([{ id: "browser", label: "Browser login (default)" }, { id: "copy_code", label: "Copy code login (headless)" }]), "copy_code");
    assert.equal(phoneSafeMethod([{ id: "a", label: "A" }]), null);
  });
  it("git guard: no developer tools -> fails fast with a hint, no dialog; with them -> real git", () => {
    const dir = tmp();
    const xsNo = join(dir, "xs-no");
    const xsYes = join(dir, "xs-yes");
    const real = join(dir, "real-git");
    writeFileSync(xsNo, "#!/bin/sh\nexit 2\n");
    writeFileSync(xsYes, "#!/bin/sh\necho /Library/Developer/CommandLineTools\n");
    writeFileSync(real, '#!/bin/sh\necho "real git $*"\n');
    for (const f of [xsNo, xsYes, real]) chmodSync(f, 0o755);
    const g = join(dir, "git");
    writeFileSync(g, gitGuardWrapper({ xcodeSelect: xsNo, appleGit: real, brewGits: [join(dir, "none")] }));
    chmodSync(g, 0o755);
    let err;
    try {
      execFileSync(g, ["status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      err = e;
    }
    assert.equal(err?.status, 127);
    assert.match(String(err?.stderr), /xcode-select --install/);
    writeFileSync(g, gitGuardWrapper({ xcodeSelect: xsYes, appleGit: real, brewGits: [join(dir, "none")] }));
    assert.equal(execFileSync(g, ["status"], { encoding: "utf8" }).trim(), "real git status");
  });
  it("CLI runs when started through a symlinked path (macOS /tmp -> /private/tmp)", () => {
    const dir = tmp();
    const { symlinkSync } = require_fs();
    symlinkSync(join(HERE, "lib"), join(dir, "lib"));
    const out = execFileSync(process.execPath, [join(dir, "lib", "cli.mjs"), "status"], { encoding: "utf8", env: { HOME: dir, PATH: "/usr/bin:/bin" } });
    assert.match(out, /Not set up/);
  });
});

describe("readiness (first-connect DAEMON_UNREACHABLE)", () => {
  it("treats 503 as not ready, any other answer as ready", () => {
    assert.equal(isReadyStatus(503), false);
    assert.equal(isReadyStatus(0), false);
    assert.equal(isReadyStatus(101), true);
    assert.equal(isReadyStatus(401), true);
  });
  it("waits through 503s with backoff", async () => {
    const answers = [0, 503, 503, 101];
    const sleeps = [];
    const r = await waitForReady({ port: 1, probe: async () => answers.shift(), sleep: async (ms) => sleeps.push(ms) });
    assert.equal(r.ready, true);
    assert.equal(r.probes, 4);
    assert.deepEqual(sleeps, [100, 150, 225]);
  });
  it("probes a real server: 503 while starting, then 101", async () => {
    let accepting = false;
    const srv = http.createServer();
    srv.on("upgrade", (req, sock) => {
      sock.end(accepting ? "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n" : "HTTP/1.1 503 Server not ready\r\n\r\n");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    assert.equal(await probeWs({ port }), 503);
    setTimeout(() => (accepting = true), 300);
    const r = await waitForReady({ port, timeoutMs: 5000 });
    assert.equal(r.ready, true);
    assert.ok(r.probes >= 2);
    srv.close();
    assert.equal(await probeWs({ port }), 0);
  });
});

describe("herdr short sockets", () => {
  it("keeps herdr's own path for normal HOMEs", () => {
    assert.equal(herdrSocketDir({ home: "/home/sam", session: "paseo-bots", env: {}, os: "linux" }), null);
  });
  it("uses a short directory for a 90-character HOME (Linux and macOS)", () => {
    const home = `/home/${"x".repeat(84)}`;
    assert.equal(home.length, 90);
    assert.equal(socketPathFits(`${home}/.config/herdr/sessions/paseo-bots/herdr-client.sock`, "linux"), false);
    const lin = herdrSocketDir({ home, session: "paseo-bots", env: { XDG_RUNTIME_DIR: "/run/user/1000" }, os: "linux", uid: 1000 });
    assert.equal(lin, `/run/user/1000/${PRODUCT_ID}-herdr-paseo-bots`);
    const noXdg = herdrSocketDir({ home, session: "paseo-bots", env: {}, os: "linux", uid: 1000 });
    assert.equal(noXdg, `/tmp/${PRODUCT_ID}-1000/${PRODUCT_ID}-herdr-paseo-bots`);
    const mac = herdrSocketDir({ home: `/Users/${"x".repeat(83)}`, session: "paseo-bots", env: {}, os: "darwin", uid: 501, darwinTemp: "/var/folders/w0/10k00fq52912vvl3qn7yrxvw0000gn/T/" });
    assert.ok(mac.startsWith("/var/folders/"));
    for (const d of [lin, noXdg, mac]) assert.ok(socketPathFits(`${d}/herdr-client.sock`, "darwin"));
  });
  it("wrapper sets both socket variables for our session only", () => {
    const dir = tmp();
    const sockDir = join(dir, "s");
    const fake = join(dir, "fake-herdr");
    writeFileSync(fake, '#!/bin/sh\necho "SOCK=${HERDR_SOCKET_PATH:-} CLIENT=${HERDR_CLIENT_SOCKET_PATH:-} ARGS=$*"\n');
    chmodSync(fake, 0o755);
    const w = join(dir, "herdr");
    writeFileSync(w, herdrWrapper({ realBin: fake, node: process.execPath, listScript: "/nonexistent", session: "paseo-bots", socketDir: sockDir }));
    chmodSync(w, 0o755);
    const runW = (env) => execFileSync(w, ["agent", "list"], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" }).trim();
    assert.equal(runW({ HERDR_SESSION: "paseo-bots" }), `SOCK=${sockDir}/herdr.sock CLIENT=${sockDir}/herdr-client.sock ARGS=agent list`);
    assert.equal(runW({ HERDR_SESSION: "other" }), "SOCK= CLIENT= ARGS=agent list");
    assert.equal(runW({ HERDR_SOCKET_PATH: "/x/y.sock" }), "SOCK=/x/y.sock CLIENT= ARGS=agent list");
    assert.equal(runW({ HERDR_SOCKET_PATH: `${sockDir}/herdr.sock` }), `SOCK=${sockDir}/herdr.sock CLIENT=${sockDir}/herdr-client.sock ARGS=agent list`);
    assert.equal(herdrWrapper({ realBin: "/r", node: "n", listScript: "l", session: "s", socketDir: null }), '#!/bin/sh\nexec "/r" "$@"\n');
  });
});

describe("doctor output and update source", () => {
  it("prints a fix under each problem and counts them", () => {
    const text = formatChecks({ ok: false, checks: [{ name: "daemon listening", status: "FAIL", detail: "nothing answers", fix: restartHint("systemd") }, { name: "versions", status: "ok", detail: "x" }] });
    assert.match(text, /FAIL  daemon listening/);
    assert.match(text, new RegExp(`fix: systemctl --user restart ${PRODUCT_ID}\\.service`));
    assert.match(text, /1 problem found/);
  });
  it("update takes a flag, then DINOBOT_TARBALL, then the download host", () => {
    const p = { os: "darwin", arch: "arm64" };
    assert.deepEqual(updateSource({ tarball: "/x.tgz", env: {}, p }), { kind: "file", src: "/x.tgz" });
    assert.deepEqual(updateSource({ env: { DINOBOT_TARBALL: "http://h/t.tgz" }, p }), { kind: "url", src: "http://h/t.tgz" });
    assert.deepEqual(updateSource({ env: {}, p, access: "public" }), { kind: "url", src: `${DOWNLOAD_BASE_URL}/${PRODUCT_ID}-darwin-arm64.tar.gz` });
  });
  it("update downloads over https only (plain http to loopback for tests)", () => {
    assert.equal(insecureUrlProblem("https://github.com/o/r/releases/latest/download/x.tgz"), null);
    assert.equal(insecureUrlProblem("http://127.0.0.1:8080/x.tgz"), null);
    assert.equal(insecureUrlProblem("http://localhost/x.tgz"), null);
    for (const url of ["http://h/t.tgz", "http://127.0.0.1.evil.example/x", "http://localhost.evil.example/x", "ftp://x/y"]) assert.match(insecureUrlProblem(url), /https only/, url);
  });
});

describe("own pi dir (split) and default packages", async () => {
  const { layout } = await import("../lib/util.mjs");
  const { writePiSetup, writeWrappers, writeDaemonEnv, DEFAULT_PI_PACKAGES, stickyEnv } = await import("../lib/config.mjs");
  const { detectSignIns } = await import("../lib/detect.mjs");
  it("lives in ~/.dinobot/pi and ignores the caller's PI_CODING_AGENT_DIR", () => {
    const L = layout({ HOME: "/h", PI_CODING_AGENT_DIR: "/h/.pi/agent" });
    assert.equal(L.piAgentDir, `/h/.${PRODUCT_ID}/pi`);
    assert.equal(L.userPiDir, "/h/.pi/agent");
  });
  it("daemon env, pi wrapper and herdr services all point at it; ~/.pi is never written", () => {
    const home = tmp();
    const L = layout({ HOME: home });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), '{"mine":true}');
    const env = writeDaemonEnv(L, { port: 1, listen: "100.64.0.7:1", directEndpoints: [] });
    assert.equal(env.PI_CODING_AGENT_DIR, L.piAgentDir);
    assert.equal(env.HOME, home);
    writeWrappers(L, "linux");
    assert.match(readFileSync(join(L.bin, "pi"), "utf8"), new RegExp(`export PI_CODING_AGENT_DIR="${L.piAgentDir}"`));
    // bot-dm / bot-room: the bundled daemon's CLI internals, not ~/.local/lib/node_modules (visual-bugs 1).
    assert.equal(env.PASEO_CLI_DIST, join(L.app, "daemon", "dist"));
    // Install-time Tailscale CLI and launchd label stick in the dinobot wrapper (visual-bugs 5: pair --link).
    assert.equal(stickyEnv({ DINOBOT_TAILSCALE_BIN: "/opt/ts/tailscale", DINOBOT_LAUNCHD_LABEL: "x.test", OTHER: "1" }), 'export DINOBOT_LAUNCHD_LABEL="x.test"\nexport DINOBOT_TAILSCALE_BIN="/opt/ts/tailscale"\n');
    assert.equal(stickyEnv({}), "");
    for (const w of ["bot-dm", "bot-room"]) {
      assert.ok(readFileSync(join(L.bin, w), "utf8").includes(`export PASEO_CLI_DIST="${join(L.app, "daemon", "dist")}"`), w);
    }
    mkdirSync(join(L.app, "pi-packages", "node_modules", "pi-web-access"), { recursive: true });
    const r = writePiSetup(L);
    assert.deepEqual(JSON.parse(readFileSync(r.settingsPath, "utf8")).packages, DEFAULT_PI_PACKAGES);
    assert.deepEqual(r.linked, ["pi-web-access"]);
    assert.equal(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"), '{"mine":true}');
    assert.ok(DEFAULT_PI_PACKAGES.includes("npm:pi-web-access"));
  });
  it("reuses API keys from the user's pi, never OAuth logins (only pre-selects them)", () => {
    const home = tmp();
    const L = layout({ HOME: home });
    mkdirSync(L.userPiDir, { recursive: true });
    writeFileSync(join(L.userPiDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or" }, "openai-codex": { type: "oauth", refresh: "r" } }));
    const s = detectSignIns({ piAgentDir: L.piAgentDir, userPiDir: L.userPiDir, home, env: {} });
    assert.deepEqual(s.found.map((f) => [f.provider, f.key]), [["openrouter", "sk-or"]]);
    assert.deepEqual(s.userOauth, ["openai-codex"]);
  });
});

describe("fail-closed verification", () => {
  it("install.sh refuses without a checksum and on a mismatch", () => {
    const sh = readFileSync(join(HERE, "install.sh"), "utf8");
    assert.match(sh, /could not get the checksum/);
    assert.match(sh, /does not match its checksum/);
    assert.match(sh, new RegExp(`^PRODUCT_ID="${PRODUCT_ID}"`, "m"));
    assert.doesNotMatch(sh, /if curl -fsSL "\$SRC\.sha256".*then/);
  });

  it("install.sh runs inside main(), refuses plain http and installs nothing unverified (rel-security H4)", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const sh = readFileSync(join(HERE, "install.sh"), "utf8");
    assert.match(sh, /^main\(\) \{$/m);
    assert.match(sh.trimEnd(), /\nmain "\$@"$/);
    assert.match(sh, /--proto =https --tlsv1\.2/);
    const dir = mkdtempSync(join(tmpdir(), "fr-sec-install-"));
    try {
      const tarball = join(dir, "fake.tar.gz");
      writeFileSync(tarball, "not a tarball");
      const run = (env) => spawnSync("sh", [join(HERE, "install.sh"), "--yes"], { env: { PATH: process.env.PATH, HOME: join(dir, "home"), DINOBOT_NAME: "T", ...env }, encoding: "utf8" });
      let r = run({ DINOBOT_TARBALL: tarball });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /could not get the checksum/);
      r = run({ DINOBOT_BASE_URL: "http://evil.example" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /refusing a plain-http download/);
      writeFileSync(`${tarball}.sha256`, "0000  fake.tar.gz\n");
      r = run({ DINOBOT_TARBALL: tarball });
      assert.match(r.stderr, /does not match its checksum/);
      assert.equal(existsSync(join(dir, "home", ".dinobot", "app")), false, "nothing unpacked");
      // A download cut off half-way runs nothing.
      const cut = join(dir, "cut.sh");
      writeFileSync(cut, sh.slice(0, Math.floor(sh.length / 2)));
      r = spawnSync("sh", [cut], { env: { PATH: process.env.PATH, HOME: join(dir, "home2") }, encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.equal(existsSync(join(dir, "home2")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("services carry HOME explicitly (launchd uses the account's home otherwise)", async () => {
  const { layout } = await import("../lib/util.mjs");
  const { launchdAgents, systemdUnits } = await import("../lib/service.mjs");
  it("launchd and systemd", () => {
    const L = layout({ HOME: "/tmp/x/h" });
    for (const [name, text] of Object.entries(launchdAgents(L))) if (!name.includes(".daemon.")) assert.match(text, /<key>HOME<\/key><string>\/tmp\/x\/h<\/string>/, name);
    const u = systemdUnits(L);
    assert.match(u[`${PRODUCT_ID}-herdr.service`], /Environment=HOME=\/tmp\/x\/h/);
  });
});
