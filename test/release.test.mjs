// Release delivery: install.sh downloads from the public GitHub release (stood in here by a local
// HTTP server on 127.0.0.1), the checksum and signature failing closed, and update's source choice.
//   node --test test/release.test.mjs   (temp dirs under ./.test-tmp3, never /tmp)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { updateSource } from "../lib/update.mjs";
import { DOWNLOAD_BASE_URL, layout, PRODUCT_ID } from "../lib/util.mjs";

const HERE = join(import.meta.dirname, "..");
const TMP = join(HERE, ".test-tmp3");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const tmp = () => mkdtempSync(join(TMP, "t-"));

const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `${PRODUCT_ID}-${OS}-${ARCH}.tar.gz`;
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** A release folder: a tiny tarball whose "node" just reports that the wizard was reached. */
function makeRelease(dir) {
  const stage = join(dir, "stage", `${PRODUCT_ID}-${OS}-${ARCH}`, "node", "bin");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "node"), '#!/bin/sh\necho "WIZARD REACHED $*"\n');
  chmodSync(join(stage, "node"), 0o755);
  const rel = join(dir, "release");
  mkdirSync(rel, { recursive: true });
  return new Promise((res, rej) =>
    execFile("tar", ["-czf", join(rel, ASSET), "-C", join(dir, "stage"), `${PRODUCT_ID}-${OS}-${ARCH}`], (e) => {
      if (e) return rej(e);
      const s = sha(readFileSync(join(rel, ASSET)));
      writeFileSync(join(rel, `${ASSET}.sha256`), `${s}  ${ASSET}\n`);
      // A signature placeholder: the fake cosign below accepts it if it arrived (fetched by the
      // same route as the tarball). Real verification: test/signing.test.mjs.
      writeFileSync(join(rel, `${ASSET}.sigstore.json`), `{"for":"${s}"}`);
      res({ rel, sha: s });
    }),
  );
}

/** A stand-in for GitHub's release downloads: GET /<file> from the release folder. */
function serve(rel) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const f = join(rel, decodeURIComponent(req.url.slice(1)));
    if (!req.url.includes("..") && existsSync(f)) return res.writeHead(200).end(readFileSync(f));
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}

// install.sh as in the source, unpinned, so the fake releases here are checked against their own .sha256.
const UNPINNED = join(TMP, "install.sh");
writeFileSync(UNPINNED, readFileSync(join(HERE, "install.sh"), "utf8").replace(/^PINNED_SHA256S="[^"]*"/m, 'PINNED_SHA256S=""'));
// A fake cosign: passes when the bundle it is given exists and names the tarball's sha256.
const FAKE_COSIGN = join(TMP, "cosign");
writeFileSync(FAKE_COSIGN, `#!/bin/sh
f=$2; b=$4
[ -s "$b" ] && grep -q "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d' ' -f1)" "$b" && exit 0
echo "Error: bad signature" >&2; exit 1
`);
chmodSync(FAKE_COSIGN, 0o755);
function runInstall(env, script = UNPINNED) {
  return new Promise((res) => {
    execFile("sh", [script, "--yes"], { env: { PATH: "/usr/bin:/bin", DINOBOT_NAME: "Test", DINOBOT_COSIGN: FAKE_COSIGN, ...env }, timeout: 60_000 }, (e, stdout, stderr) =>
      res({ code: e ? (e.code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

describe("install.sh: public release download, checksum and signature fail closed", () => {
  let rel, good, srv;
  before(async () => {
    ({ rel, sha: good } = await makeRelease(tmp()));
    srv = await serve(rel);
  });
  after(() => srv.server.close());

  it("downloads from the public GitHub release by default (product.json, stamped); no login routes", () => {
    const sh = readFileSync(join(HERE, "install.sh"), "utf8");
    assert.match(sh, new RegExp(`^DEFAULT_BASE_URL="${DOWNLOAD_BASE_URL.replace(/[.]/g, "\\.")}"`, "m"));
    assert.match(DOWNLOAD_BASE_URL, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download$/);
    assert.doesNotMatch(sh, /DINOBOT_GITHUB_TOKEN|gh auth login|RELEASE_ACCESS|invitations/);
  });

  it("url route: tarball, .sha256 and signature from the release, then the wizard", async () => {
    const h = tmp();
    srv.hits.length = 0;
    const r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: srv.url });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /WIZARD REACHED/);
    assert.deepEqual(srv.hits.sort(), [`/${ASSET}`, `/${ASSET}.sha256`, `/${ASSET}.sigstore.json`]);
  });

  it("a tampered tarball, a missing .sha256 or a missing signature is refused, nothing installed", async () => {
    const { rel: rel2 } = await makeRelease(tmp());
    const srv2 = await serve(rel2);
    try {
      writeFileSync(join(rel2, `${ASSET}.sha256`), `${"0".repeat(64)}  ${ASSET}\n`);
      let h = tmp();
      let r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: srv2.url });
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /does not match its checksum/);
      assert.equal(existsSync(join(h, ".db", "app")), false, r.out);
      rmSync(join(rel2, `${ASSET}.sha256`));
      h = tmp();
      r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: srv2.url });
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /could not get the checksum/);
      assert.equal(existsSync(join(h, ".db", "app")), false, r.out);
    } finally {
      srv2.server.close();
    }
    const { rel: rel3 } = await makeRelease(tmp());
    rmSync(join(rel3, `${ASSET}.sigstore.json`));
    const h = tmp();
    const r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: `file://${rel3}` });
    assert.notEqual(r.code, 0, r.out);
    assert.equal(existsSync(join(h, ".db", "app")), false, r.out);
  });

  it("no release published yet (404): says so plainly, nothing installed", async () => {
    const empty = join(tmp(), "release");
    mkdirSync(empty);
    const srv0 = await serve(empty);
    try {
      const h = tmp();
      const r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: srv0.url });
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /no release has been published yet/, r.out);
      assert.match(r.out, /Nothing was installed/);
      assert.equal(existsSync(join(h, ".db", "app")), false, r.out);
    } finally {
      srv0.server.close();
    }
  });

  it("a plain-http download from anywhere but this computer is refused", async () => {
    const h = tmp();
    const r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: "http://example.com/rel" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /refusing a plain-http download/);
  });

  it("pinned checksum: matches -> installs; disagrees with the release's .sha256 -> refused", async () => {
    const src = readFileSync(UNPINNED, "utf8");
    const pin = (s) => src.replace(/^PINNED_SHA256S=""/m, `PINNED_SHA256S="${ASSET}=${s}"`);
    const ok = join(tmp(), "install.sh");
    writeFileSync(ok, pin(good));
    let h = tmp();
    let r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: `file://${rel}` }, ok);
    assert.equal(r.code, 0, r.out);
    const bad = join(tmp(), "install.sh");
    writeFileSync(bad, pin("f".repeat(64)));
    h = tmp();
    r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: `file://${rel}` }, bad);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /does not match the checksum in this install script/);
    assert.equal(existsSync(join(h, ".db", "app")), false);
  });

  it("pinned checksum alone is enough when the release has no .sha256", async () => {
    const { rel: rel3, sha: s3 } = await makeRelease(tmp());
    rmSync(join(rel3, `${ASSET}.sha256`));
    const p = join(tmp(), "install.sh");
    writeFileSync(p, readFileSync(UNPINNED, "utf8").replace(/^PINNED_SHA256S=""/m, `PINNED_SHA256S="${ASSET}=${s3}"`));
    const h = tmp();
    const r = await runInstall({ HOME: h, DINOBOT_HOME: join(h, ".db"), DINOBOT_BASE_URL: `file://${rel3}` }, p);
    assert.equal(r.code, 0, r.out);
  });
});

describe("update: release source", () => {
  const p = { os: "darwin", arch: "arm64" };
  it("the latest GitHub release by default, one tag with DINOBOT_RELEASE, a saved file:// base -> a local file", () => {
    assert.deepEqual(updateSource({ env: {}, p }), { kind: "url", src: `${DOWNLOAD_BASE_URL}/${PRODUCT_ID}-darwin-arm64.tar.gz` });
    assert.deepEqual(updateSource({ env: { DINOBOT_RELEASE: "v1.2.0" }, p }), {
      kind: "url",
      src: `${DOWNLOAD_BASE_URL.replace(/\/latest\/download$/, "/download/v1.2.0")}/${PRODUCT_ID}-darwin-arm64.tar.gz`,
    });
    assert.deepEqual(updateSource({ env: {}, p, savedBaseUrl: "file:///srv/rel/" }), { kind: "file", src: `/srv/rel/${PRODUCT_ID}-darwin-arm64.tar.gz` });
  });
});

describe("update: no release published yet", () => {
  // update() prints with process.stdout.write; run it in a child (async: the stand-in server is in this process).
  const quiet = (L, opts) =>
    new Promise((res) => {
      const code = `import { update } from ${JSON.stringify(join(HERE, "lib", "update.mjs"))};
        const r = await update(${JSON.stringify(L)}, ${JSON.stringify(opts)}); console.log("RESULT" + JSON.stringify(r));`;
      execFile(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, DINOBOT_BASE_URL: "" }, timeout: 60_000 }, (e, stdout, stderr) => {
        const m = /RESULT(.*)/.exec(stdout);
        res({ r: m ? JSON.parse(m[1]) : { crashed: stderr }, out: stdout + stderr });
      });
    });
  it("update and update --check say there is no release (404), nothing changed", async () => {
    const empty = join(tmp(), "release");
    mkdirSync(empty);
    const srv0 = await serve(empty);
    try {
      const L = layout({ HOME: join(tmp(), "h") });
      mkdirSync(L.app, { recursive: true });
      writeFileSync(join(L.app, "MANIFEST.json"), JSON.stringify({ built: "old" }));
      writeFileSync(L.state, JSON.stringify({ tarballSha256: "old", serviceMode: "none", port: 1, downloadBaseUrl: srv0.url }));
      for (const check of [false, true]) {
        const { r, out } = await quiet(L, { check });
        assert.equal(r.ok, false, out);
        assert.match(out, /no release has been published yet/i, out);
      }
      assert.equal(JSON.parse(readFileSync(join(L.app, "MANIFEST.json"), "utf8")).built, "old");
    } finally {
      srv0.server.close();
    }
  });
});

describe("pi settings for a fresh Mac (no npm) and quiet pi (wave 3)", async () => {
  const { layout } = await import("../lib/util.mjs");
  const { writePiSetup, writeWrappers, PI_ENV } = await import("../lib/config.mjs");
  it("points pi's npmCommand at the bundled npm, cache inside ~/.dinobot; keeps a user's own", () => {
    const h = tmp();
    const L = layout({ HOME: h });
    const cli = join(L.app, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "");
    writePiSetup(L);
    const s = JSON.parse(readFileSync(join(L.piAgentDir, "settings.json"), "utf8"));
    assert.deepEqual(s.npmCommand.slice(0, 3), [join(L.root, "libexec", "npm"), "--cache", join(L.root, "npm-cache")]);
    // Named "npm" so pi uses its npm flags (--omit=dev); runs the bundled npm-cli.js with our Node.
    assert.match(readFileSync(s.npmCommand[0], "utf8"), new RegExp(`exec "${L.node}" "${cli}"`));
    s.npmCommand = ["/opt/homebrew/bin/npm"];
    writeFileSync(join(L.piAgentDir, "settings.json"), JSON.stringify(s));
    writePiSetup(L);
    assert.deepEqual(JSON.parse(readFileSync(join(L.piAgentDir, "settings.json"), "utf8")).npmCommand, ["/opt/homebrew/bin/npm"]);
  });
  it("no bundled npm (BUNDLE_NPM=0): pi's default is left alone", () => {
    const L = layout({ HOME: tmp() });
    writePiSetup(L);
    assert.equal(JSON.parse(readFileSync(join(L.piAgentDir, "settings.json"), "utf8")).npmCommand, undefined);
  });
  it("every DinoBot pi skips pi's version check (no 'Update available' in workers)", () => {
    const L = layout({ HOME: tmp() });
    writeWrappers(L);
    const w = readFileSync(join(L.bin, "pi"), "utf8");
    assert.match(w, /export PI_SKIP_VERSION_CHECK=1/);
    assert.equal(PI_ENV.PI_SKIP_VERSION_CHECK, "1");
  });
});

describe("launchd stop/start race (dinobot stop && dinobot start on a Mac)", async () => {
  const { launchdBootout, launchdBootstrap } = await import("../lib/service.mjs");
  const fakeLaunchd = (stopTicks) => {
    let loaded = true;
    let stopping = 0;
    const calls = [];
    const exec = async (_cmd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "bootout") { stopping = stopTicks; return { code: 0, stderr: "" }; }
      if (args[0] === "print") {
        if (stopping > 0) { stopping--; if (stopping === 0) loaded = false; return { code: 0, stderr: "" }; }
        return { code: loaded ? 0 : 113, stderr: "" };
      }
      if (args[0] === "bootstrap") {
        if (stopping > 0) { stopping--; if (stopping === 0) loaded = false; return { code: 5, stderr: "Bootstrap failed: 5: Input/output error" }; }
        if (loaded) return { code: 37, stderr: "Bootstrap failed: 37: Operation already in progress" };
        loaded = true;
        return { code: 0, stderr: "" };
      }
      return { code: 0, stderr: "" };
    };
    return { exec, calls, state: () => ({ loaded, stopping }) };
  };
  const sleep = async () => {};
  it("bootout waits until launchd has dropped the job; bootstrap then succeeds", async () => {
    const f = fakeLaunchd(4);
    assert.equal(await launchdBootout(501, "x.daemon", { exec: f.exec, sleep }), true);
    assert.equal(f.state().loaded, false);
    assert.equal(await launchdBootstrap(501, "x.daemon", "/p.plist", { exec: f.exec, sleep }), true);
    assert.equal(f.state().loaded, true);
  });
  it("bootstrap retries on 5: Input/output error while the old one still stops", async () => {
    const f = fakeLaunchd(3);
    await f.exec("launchctl", ["bootout", "gui/501/x.daemon"]); // a bootout that did not wait
    assert.equal(await launchdBootstrap(501, "x.daemon", "/p.plist", { exec: f.exec, sleep }), true);
    assert.ok(f.calls.filter((c) => c.startsWith("bootstrap")).length > 1);
  });
});
