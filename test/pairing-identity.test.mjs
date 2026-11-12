// RU1: an update or port must keep what a paired phone holds on to.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { describeDrift, pairingDrift, pairingIdentity } from "../lib/pairing-identity.mjs";
import { layout, PRODUCT_ID } from "../lib/util.mjs";

const HERE = new URL("..", import.meta.url).pathname;
const TMP = mkdtempSync(join(tmpdir(), "pairing-identity-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function install() {
  const root = mkdtempSync(join(TMP, "i-"));
  const paseoHome = join(root, "paseo");
  mkdirSync(paseoHome);
  writeFileSync(join(paseoHome, "daemon-keypair.json"), JSON.stringify({ v: 2, publicKeyB64: "pub-A", secretKeyB64: "sec-A" }));
  writeFileSync(join(paseoHome, "server-id"), "srv_A\n");
  const envFile = join(root, "daemon.env");
  writeFileSync(envFile, `PASEO_HOME=${paseoHome}\nPASEO_LISTEN=100.64.0.1:6767\nPASEO_PASSWORD=pw-A\n`);
  return { root, paseoHome, envFile };
}

describe("pairing identity (RU1)", () => {
  it("is unchanged when nothing pairing-related changed, and holds no secret", () => {
    const i = install();
    const before = pairingIdentity(i);
    assert.deepEqual(pairingDrift(before, pairingIdentity(i)), []);
    const text = JSON.stringify(before);
    for (const secret of ["pub-A", "sec-A", "srv_A", "pw-A"]) assert.ok(!text.includes(secret), secret);
  });

  it("a first start may add the token key and kept hash; once there, they must stay", () => {
    const i = install();
    const before = pairingIdentity(i);
    writeFileSync(join(i.paseoHome, "session-tokens.json"), JSON.stringify({ version: 1, key: "k1", entries: [] }));
    writeFileSync(join(i.paseoHome, "daemon-password-hash"), "$2b$12$x\n");
    const started = pairingIdentity(i);
    assert.deepEqual(pairingDrift(before, started), []);
    writeFileSync(join(i.paseoHome, "session-tokens.json"), JSON.stringify({ version: 1, key: "k2", entries: [] }));
    assert.deepEqual(pairingDrift(started, pairingIdentity(i)), ["sessionTokenKey"]);
  });

  it("names each change that would make the phone pair again", () => {
    const cases = {
      daemonKey: (i) => writeFileSync(join(i.paseoHome, "daemon-keypair.json"), JSON.stringify({ publicKeyB64: "pub-B" })),
      serverId: (i) => writeFileSync(join(i.paseoHome, "server-id"), "srv_B\n"),
      listen: (i) => writeFileSync(i.envFile, readFileSync(i.envFile, "utf8").replace("6767", "6768")),
      password: (i) => writeFileSync(i.envFile, readFileSync(i.envFile, "utf8").replace("pw-A", "pw-B")),
    };
    for (const [field, change] of Object.entries(cases)) {
      const i = install();
      const before = pairingIdentity(i);
      change(i);
      assert.deepEqual(pairingDrift(before, pairingIdentity(i)), [field], field);
    }
    const i = install();
    const before = pairingIdentity(i);
    rmSync(join(i.paseoHome, "daemon-keypair.json"));
    const drift = pairingDrift(before, pairingIdentity(i));
    assert.deepEqual(drift, ["daemonKey"]);
    assert.match(describeDrift(drift), /daemon key/);
  });

  it("CLI (the manual port path): verify exits 1 and says what changed", () => {
    const i = install();
    const cli = join(HERE, "lib", "pairing-identity.mjs");
    const snap = spawnSync(process.execPath, [cli, "snapshot", "--paseo-home", i.paseoHome, "--env-file", i.envFile], { encoding: "utf8" });
    assert.equal(snap.status, 0, snap.stderr);
    const file = join(i.root, "before.json");
    writeFileSync(file, snap.stdout);
    assert.equal(spawnSync(process.execPath, [cli, "verify", file]).status, 0);
    writeFileSync(join(i.paseoHome, "server-id"), "srv_new\n");
    const bad = spawnSync(process.execPath, [cli, "verify", file], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /PAIRING WOULD BREAK: changed server id/);
  });
});

describe("dinobot update keeps the pairing (RU1)", () => {
  const OS = process.platform === "darwin" ? "darwin" : "linux";
  const ARCH = process.arch === "x64" ? "x64" : "arm64";
  /** A release whose Node, when update() probes it, runs `script` (e.g. rewrites the server id). */
  function release(dir, script) {
    const name = `${PRODUCT_ID}-${OS}-${ARCH}`;
    const stage = join(dir, "stage", name);
    mkdirSync(join(stage, "node", "bin"), { recursive: true });
    writeFileSync(join(stage, "node", "bin", "node"), `#!/bin/sh\n${script}\necho v24.0.0\n`);
    chmodSync(join(stage, "node", "bin", "node"), 0o755);
    writeFileSync(join(stage, "MANIFEST.json"), JSON.stringify({ built: "new" }));
    const tar = join(dir, `${name}.tar.gz`);
    spawnSync("tar", ["-czf", tar, "-C", join(dir, "stage"), name]);
    writeFileSync(`${tar}.sha256`, `${createHash("sha256").update(readFileSync(tar)).digest("hex")}  ${name}.tar.gz\n`);
    return tar;
  }
  function installed(d) {
    const L = layout({ HOME: join(d, "h") });
    mkdirSync(L.app, { recursive: true });
    mkdirSync(L.paseoHome, { recursive: true });
    writeFileSync(join(L.app, "MANIFEST.json"), JSON.stringify({ built: "old" }));
    writeFileSync(L.state, JSON.stringify({ tarballSha256: "old", serviceMode: "none", port: 1 }));
    writeFileSync(join(L.paseoHome, "server-id"), "srv_A\n");
    writeFileSync(join(L.paseoHome, "daemon-keypair.json"), JSON.stringify({ publicKeyB64: "pub-A" }));
    writeFileSync(L.envFile, `PASEO_HOME=${L.paseoHome}\nPASEO_LISTEN=127.0.0.1:1\nPASEO_PASSWORD=pw\n`);
    return L;
  }
  const quiet = (L, opts) => {
    const code = `import { update } from ${JSON.stringify(join(HERE, "lib", "update.mjs"))};
      const r = await update(${JSON.stringify(L)}, ${JSON.stringify(opts)}); console.log("RESULT" + JSON.stringify(r));`;
    const c = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, DINOBOT_ALLOW_UNSIGNED: "1", DINOBOT_BASE_URL: "" } });
    const m = /RESULT(.*)/.exec(c.stdout);
    return { r: m ? JSON.parse(m[1]) : { crashed: c.stderr }, out: c.stdout + c.stderr };
  };

  it("an update that would change the server id stops before the restart and puts the old version back", () => {
    const d = mkdtempSync(join(TMP, "u-"));
    const L = installed(d);
    const tar = release(d, `echo srv_CHANGED > "${join(L.paseoHome, "server-id")}"`);
    const { r, out } = quiet(L, { tarball: tar });
    assert.equal(r.ok, false, out);
    assert.deepEqual(r.pairingDrift, ["serverId"], out);
    assert.match(out, /STOPPED before the restart: .*server id.*pair again/);
    assert.equal(JSON.parse(readFileSync(join(L.app, "MANIFEST.json"), "utf8")).built, "old");
    assert.ok(!existsSync(join(L.root, "app.new")));
    assert.equal(JSON.parse(readFileSync(L.state, "utf8")).tarballSha256, "old");
  });
});
