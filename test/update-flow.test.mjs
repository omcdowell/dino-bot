// `dinobot update` (installer-polish): no download when up to date (the release's .sha256 is
// compared first), old -> new version, the NEW version's post-update step, and rollback when that
// step fails or the new daemon does not start. Download helpers: progress line, resume totals.
//   node --test test/update-flow.test.mjs   (temp HOMEs under ./.test-tmp-update-flow)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { headerTotal, progressLine } from "../lib/update.mjs";
import { layout, PRODUCT_ID } from "../lib/util.mjs";

const HERE = join(import.meta.dirname, "..");
const TMP = join(HERE, ".test-tmp-update-flow");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "x64" ? "x64" : "arm64";
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** An app folder: a Node that is this test's node, the real installer code at `version`; `patch` edits post-update.mjs. */
function app(dir, { version, built, patch = (s) => s }) {
  mkdirSync(join(dir, "node", "bin"), { recursive: true });
  writeFileSync(join(dir, "node", "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(dir, "node", "bin", "node"), 0o755);
  cpSync(join(HERE, "lib"), join(dir, "installer", "lib"), { recursive: true });
  const pj = join(dir, "installer", "lib", "product.json");
  writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, "utf8")), version }));
  const pu = join(dir, "installer", "lib", "post-update.mjs");
  writeFileSync(pu, patch(readFileSync(pu, "utf8")));
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ built }));
}

/** A release tarball (+ .sha256) of app(). */
function release(d, opts) {
  const name = `${PRODUCT_ID}-${OS}-${ARCH}`;
  app(join(d, "stage", name), opts);
  const tar = join(d, `${name}.tar.gz`);
  spawnSync("tar", ["-czf", tar, "-C", join(d, "stage"), name]);
  writeFileSync(`${tar}.sha256`, `${sha(tar)}  ${name}.tar.gz\n`);
  return tar;
}

function installed(d, { sha256 = "old" } = {}) {
  const L = layout({ HOME: join(d, "h") });
  app(L.app, { version: "0.1.8", built: "old" });
  mkdirSync(L.paseoHome, { recursive: true });
  writeFileSync(L.state, JSON.stringify({ tarballSha256: sha256, serviceMode: "none", port: 1 }));
  writeFileSync(join(L.paseoHome, "server-id"), "srv_A\n");
  writeFileSync(join(L.paseoHome, "daemon-keypair.json"), JSON.stringify({ publicKeyB64: "pub-A" }));
  writeFileSync(L.envFile, `PASEO_HOME=${L.paseoHome}\nPASEO_LISTEN=127.0.0.1:1\nPASEO_PASSWORD=pw\n`);
  return L;
}

/** update() in a child (it prints to stdout), with stand-ins for the restart. `ready`: answers of waitForReady in turn. */
function runUpdate(L, opts, { ready = [true], env = {} } = {}) {
  const code = `import { update } from ${JSON.stringify(join(HERE, "lib", "update.mjs"))};
    const answers = ${JSON.stringify(ready)}; const calls = [];
    const r = await update(${JSON.stringify(L)}, ${JSON.stringify(opts)}, {
      startServices: async (_L, mode, o) => { calls.push("start " + mode + (o.restart ? " restart" : "")); return []; },
      waitForReady: async () => ({ ready: answers.length > 1 ? answers.shift() : answers[0] }),
    });
    console.log("RESULT" + JSON.stringify({ ...r, calls }));`;
  const c = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: L.home, DINOBOT_ALLOW_UNSIGNED: "1", DINOBOT_NO_PATH_LINK: "1", ...env }, timeout: 120_000 });
  const m = /RESULT(.*)/.exec(c.stdout);
  return { r: m ? JSON.parse(m[1]) : { crashed: c.stderr }, out: c.stdout + c.stderr };
}
const builtOf = (L) => JSON.parse(readFileSync(join(L.app, "MANIFEST.json"), "utf8")).built;

describe("update: up to date without downloading", () => {
  it("the release's .sha256 is the installed one: says so with the version, copies nothing", () => {
    const d = mkdtempSync(join(TMP, "u-"));
    const tar = release(d, { version: "0.1.9", built: "new" });
    const L = installed(d, { sha256: sha(tar) });
    rmSync(tar); // only the .sha256 is left: a download would fail
    const { r, out } = runUpdate(L, { tarball: tar });
    assert.equal(r.ok, true, out);
    assert.equal(r.changed, false);
    assert.match(out, /DinoBot 0\.1\.8 is already up to date\./);
    assert.doesNotMatch(out, /download/i);
    assert.deepEqual(r.calls, [], "no restart");
  });
});

describe("update: the new version's post-update step", () => {
  it("runs with the NEW code (its own Node), then restarts; says old -> new version", () => {
    const d = mkdtempSync(join(TMP, "u-"));
    const marker = (s) => s.replace("  return { ok: true, pathLink", '  (await import("node:fs")).writeFileSync(process.env.HOME + "/new-code-ran", JSON.parse((await import("node:fs")).readFileSync(new URL("./product.json", import.meta.url), "utf8")).version);\n  return { ok: true, pathLink');
    const tar = release(d, { version: "0.1.9", built: "new", patch: marker });
    const L = installed(d);
    // An older install's wrapper exported the shared-Mac settings: the step moves them to install.env.
    const { r, out } = runUpdate(L, { tarball: tar }, { env: { DINOBOT_TAILSCALE_BIN: "/opt/ts/tailscale" } });
    assert.equal(r.ok, true, out);
    assert.equal(readFileSync(join(L.home, "new-code-ran"), "utf8"), "0.1.9", "post-update ran from the new app");
    assert.match(readFileSync(join(L.home, ".config", PRODUCT_ID, "install.env"), "utf8"), /^DINOBOT_TAILSCALE_BIN=\/opt\/ts\/tailscale$/m);
    assert.doesNotMatch(readFileSync(join(L.bin, PRODUCT_ID), "utf8"), /DINOBOT_TAILSCALE_BIN/, "no longer in the wrapper");
    assert.deepEqual(r.calls, ["start none restart"]);
    assert.match(out, /Updated DinoBot 0\.1\.8 -> 0\.1\.9 in /);
    assert.equal(builtOf(L), "new");
    assert.ok(readFileSync(join(L.bin, PRODUCT_ID), "utf8").includes(join(L.app, "installer", "lib", "cli.mjs")), "wrappers written");
    assert.equal(JSON.parse(readFileSync(L.state, "utf8")).tarballSha256, sha(tar));
  });

  it("the new step fails: the previous version is put back, nothing restarted, state unchanged", () => {
    const d = mkdtempSync(join(TMP, "u-"));
    const broken = () => 'export async function postUpdate() { return { ok: false, why: "broken on purpose" }; }\n';
    const tar = release(d, { version: "0.1.9", built: "new", patch: broken });
    const L = installed(d);
    const { r, out } = runUpdate(L, { tarball: tar });
    assert.equal(r.ok, false, out);
    assert.equal(r.rolledBack, true);
    assert.match(out, /setup step failed \(exit 1\); putting the previous version back/);
    assert.deepEqual(r.calls, [], "daemon not restarted");
    assert.equal(builtOf(L), "old");
    assert.ok(!existsSync(join(L.root, "app.new")));
    assert.equal(JSON.parse(readFileSync(L.state, "utf8")).tarballSha256, "old");
    assert.ok(readFileSync(join(L.bin, PRODUCT_ID), "utf8").includes(join(L.app, "installer", "lib", "cli.mjs")), "wrappers of the old app");
  });

  it("the new daemon does not become ready: rolled back and restarted on the previous version", () => {
    const d = mkdtempSync(join(TMP, "u-"));
    const tar = release(d, { version: "0.1.9", built: "new" });
    const L = installed(d);
    const { r, out } = runUpdate(L, { tarball: tar }, { ready: [false, true] });
    assert.equal(r.ok, false, out);
    assert.equal(r.rolledBack, true);
    assert.deepEqual(r.calls, ["start none restart", "start none restart"]);
    assert.match(out, /Rolled back; the previous version is running\./);
    assert.equal(builtOf(L), "old");
    assert.equal(JSON.parse(readFileSync(L.state, "utf8")).tarballSha256, "old");
  });

  it("a release without post-update.mjs (older): its steps run in this process", () => {
    const d = mkdtempSync(join(TMP, "u-"));
    const tar = release(d, { version: "0.1.7", built: "older" });
    rmSync(join(d, "stage"), { recursive: true });
    // Re-pack without the file.
    const name = `${PRODUCT_ID}-${OS}-${ARCH}`;
    app(join(d, "stage", name), { version: "0.1.7", built: "older" });
    rmSync(join(d, "stage", name, "installer", "lib", "post-update.mjs"));
    spawnSync("tar", ["-czf", tar, "-C", join(d, "stage"), name]);
    writeFileSync(`${tar}.sha256`, `${sha(tar)}  x\n`);
    const L = installed(d);
    const { r, out } = runUpdate(L, { tarball: tar });
    assert.equal(r.ok, true, out);
    assert.equal(builtOf(L), "older");
    assert.ok(existsSync(join(L.bin, PRODUCT_ID)));
  });
});

describe("update: over the network", () => {
  it("a connection dropped mid-download is resumed (Range), then installs", async () => {
    const d = mkdtempSync(join(TMP, "u-"));
    const tar = release(d, { version: "0.1.9", built: "new" });
    const body = readFileSync(tar);
    const log = [];
    const srv = http.createServer((req, res) => {
      const f = join(d, req.url.slice(1));
      if (!existsSync(f) || f === d) return res.writeHead(404).end();
      const data = readFileSync(f);
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
      const from = m ? Number(m[1]) : 0;
      log.push(`${req.url} ${req.headers.range ?? "-"}`);
      const rest = data.subarray(from);
      res.writeHead(m ? 206 : 200, { "content-length": rest.length, ...(m ? { "content-range": `bytes ${from}-${data.length - 1}/${data.length}` } : {}) });
      if (f === tar && !m) return res.write(rest.subarray(0, Math.floor(body.length / 2)), () => res.socket.destroy());
      res.end(rest);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}/${tar.split("/").pop()}`;
    const L = installed(d);
    const code = `import { update } from ${JSON.stringify(join(HERE, "lib", "update.mjs"))};
      const r = await update(${JSON.stringify(L)}, { url: ${JSON.stringify(url)} }, { startServices: async () => [], waitForReady: async () => ({ ready: true }) });
      console.log("RESULT" + JSON.stringify(r));`;
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { PATH: process.env.PATH, HOME: L.home, DINOBOT_ALLOW_UNSIGNED: "1", DINOBOT_NO_PATH_LINK: "1" } });
      let o = "";
      c.stdout.on("data", (b) => (o += b));
      c.stderr.on("data", (b) => (o += b));
      c.on("close", () => resolve(o));
    });
    srv.close();
    const r = JSON.parse(/RESULT(.*)/.exec(out)?.[1] ?? "{}");
    assert.equal(r.ok, true, out + log.join("\n"));
    const tries = log.filter((l) => l.startsWith(`/${tar.split("/").pop()} `));
    assert.equal(tries.length, 2, log.join("\n"));
    assert.match(tries[1], /bytes=\d+-$/);
    assert.match(out, /DinoBot 0\.1\.8: downloading the update/);
    assert.equal(builtOf(L), "new");
  });
});

describe("update: download helpers", () => {
  it("headerTotal: last response's Content-Length, or the total of a Content-Range (resumed)", () => {
    assert.equal(headerTotal("HTTP/1.1 302 Found\r\ncontent-length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 1234\r\n\r\n"), 1234);
    assert.equal(headerTotal("HTTP/1.1 206 Partial\r\nContent-Length: 100\r\nContent-Range: bytes 900-999/1000\r\n\r\n"), 1000);
    assert.equal(headerTotal(""), null);
  });
  it("progressLine: a bar with percent and MB; MB only when the size is unknown", () => {
    assert.equal(progressLine(32 * 1048576, 128 * 1048576), `Downloading  [#####---------------]  25%  32/128 MB`);
    assert.equal(progressLine(5 * 1048576, null), "Downloading  5 MB");
  });
});
