// Shared-Mac settings that survive uninstall (~/.config/dinobot/install.env), the built-in
// "shared Tailscale address" route, the safety stop's wording, quieter edges of setup and the
// bare `dinobot` command (installer-polish).
//   node --test test/install-env.test.mjs   (temp HOMEs under ./.test-tmp-install-env)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { foreignTailscaleMessage, SHARED_MAC_DOC, USAGE } from "../lib/cli.mjs";
import { detectTailscale, foreignTailscale, sleepNote, tailnetAddress } from "../lib/detect.mjs";
import { installEnvPath, loadInstallEnv, readInstallEnv, saveInstallEnv } from "../lib/install-env.mjs";
import { listenPlan } from "../lib/config.mjs";
import { tailscaleSteps } from "../lib/tailscale.mjs";
import { PRODUCT_ID, RELEASE_REPO } from "../lib/util.mjs";

const HERE = join(import.meta.dirname, "..");
const TMP = join(HERE, ".test-tmp-install-env");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const home = () => join(TMP, `h${++n}`);
const NETS = { utun4: [{ address: "100.64.0.12", family: "IPv4", internal: false }] };

describe("install.env", () => {
  it("lives in ~/.config/dinobot, mode 600; only the shared-Mac keys; writes only on a change", () => {
    const p = installEnvPath(home());
    assert.match(p, new RegExp(`/\\.config/${PRODUCT_ID}/install\\.env$`));
    assert.deepEqual(saveInstallEnv({ PATH: "/x", HOME: "/h" }, p), [], "nothing to save: no file");
    assert.equal(existsSync(p), false);
    assert.deepEqual(saveInstallEnv({ DINOBOT_TAILNET_ADDRESS: "100.64.0.12", DINOBOT_PORT: "6747", OTHER: "1" }, p), ["DINOBOT_TAILNET_ADDRESS", "DINOBOT_PORT"]);
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.deepEqual(readInstallEnv(p), { DINOBOT_TAILNET_ADDRESS: "100.64.0.12", DINOBOT_PORT: "6747" });
    assert.deepEqual(saveInstallEnv({ DINOBOT_PORT: "6747" }, p), [], "same value: no write");
    assert.deepEqual(saveInstallEnv({ DINOBOT_TAILSCALE_BIN: "/b/ts" }, p), ["DINOBOT_TAILSCALE_BIN"]);
    assert.deepEqual(readInstallEnv(p), { DINOBOT_TAILNET_ADDRESS: "100.64.0.12", DINOBOT_TAILSCALE_BIN: "/b/ts", DINOBOT_PORT: "6747" }, "earlier keys kept");
  });
  it("load: fills what the environment lacks; the environment wins", () => {
    const p = installEnvPath(home());
    saveInstallEnv({ DINOBOT_PORT: "6747", DINOBOT_TAILNET_ADDRESS: "100.64.0.12" }, p);
    const env = { DINOBOT_PORT: "7000" };
    assert.deepEqual(loadInstallEnv(env, p).used, ["DINOBOT_TAILNET_ADDRESS"]);
    assert.equal(env.DINOBOT_PORT, "7000");
    assert.equal(env.DINOBOT_TAILNET_ADDRESS, "100.64.0.12");
    assert.deepEqual(loadInstallEnv({}, join(TMP, "none")).used, []);
  });
  it("every `dinobot` command reads it (here: pair, without the env var, finds the saved Tailscale CLI)", () => {
    const h = home();
    const fake = join(h, "ts");
    mkdirSync(h, { recursive: true });
    writeFileSync(fake, `#!/bin/sh\necho called >> "${join(h, "ts.log")}"\necho '{"BackendState":"Stopped","Self":{}}'\nexit 1\n`, { mode: 0o755 });
    saveInstallEnv({ DINOBOT_TAILSCALE_BIN: fake }, installEnvPath(h));
    mkdirSync(join(h, `.${PRODUCT_ID}`), { recursive: true });
    writeFileSync(join(h, `.${PRODUCT_ID}`, "state.json"), JSON.stringify({ port: 1 }));
    spawnSync(process.execPath, [join(HERE, "lib", "cli.mjs"), "pair"], { env: { PATH: process.env.PATH, HOME: h }, encoding: "utf8" });
    assert.ok(existsSync(join(h, "ts.log")), "the saved CLI was asked");
  });
});

describe("shared Mac, route A: DINOBOT_TAILNET_ADDRESS (the owner shared this Mac with your Tailscale)", () => {
  it("an address of this computer: Tailscale counts as running there, no CLI asked; listens on it", async () => {
    const t = tailnetAddress("100.64.0.12,owner-mac.tail1.ts.net", { nets: NETS });
    assert.equal(t.running, true);
    assert.equal(t.ip, "100.64.0.12");
    assert.equal(t.dnsName, "owner-mac.tail1.ts.net");
    assert.deepEqual(listenPlan({ tailscale: t, port: 6747, nets: NETS }), { listen: "100.64.0.12:6747", probeHost: "100.64.0.12" });
    const viaEnv = await detectTailscale({ env: { DINOBOT_TAILNET_ADDRESS: "100.64.0.12" }, nets: NETS, bins: ["/nonexistent/tailscale"] });
    assert.equal(viaEnv.running, true);
    assert.equal(viaEnv.dnsName, null);
  });
  it("not an address of this computer: off, with the reason and what to do (no waiting)", () => {
    const t = tailnetAddress("100.64.0.99", { nets: NETS });
    assert.equal(t.running, false);
    assert.match(t.fixedProblem, /100\.64\.0\.99 is not an address of this computer/);
    const steps = tailscaleSteps(t, { os: "darwin", rerun: "dinobot setup" }).join("\n");
    assert.match(steps, /not an address of this computer/);
    assert.match(steps, /unset DINOBOT_TAILNET_ADDRESS/);
    assert.doesNotMatch(steps, /App Store/);
    assert.match(tailnetAddress("nope", { nets: NETS }).fixedProblem, /not an IPv4 address/);
  });
  it("is an explicit choice: the other-user safety stop does not apply", async () => {
    const ps = "501 /Applications/Tailscale.app/Contents/MacOS/Tailscale\n";
    const tailscale = { running: true, ip: "100.64.0.12" };
    assert.notEqual(await foreignTailscale({ env: {}, tailscale, os: "darwin", uid: 502, ps, nameOf: async () => "owner" }), null);
    assert.equal(await foreignTailscale({ env: { DINOBOT_TAILNET_ADDRESS: "100.64.0.12" }, tailscale, os: "darwin", uid: 502, ps }), null);
  });
});

describe("the safety stop's message", () => {
  it("both routes (A prefilled with the Mac's address), a full doc link, the exact rerun command", () => {
    const msg = foreignTailscaleMessage({ owners: ["alex (uid 501)"] }, { ip: "100.64.0.12", dnsName: "owner-mac.tail1.ts.net" }, { rerun: "/Users/f/.dinobot/bin/dinobot setup" });
    assert.equal(SHARED_MAC_DOC, `https://github.com/${RELEASE_REPO}/blob/main/docs/shared-mac.md`);
    assert.ok(msg.includes(SHARED_MAC_DOC));
    assert.match(msg, /export DINOBOT_TAILNET_ADDRESS=100\.64\.0\.12 DINOBOT_PORT=/);
    assert.match(msg, /DINOBOT_TAILSCALE_SOCKET=/);
    assert.match(msg, /nothing is downloaded again/);
    assert.match(msg, /\n {2}\/Users\/f\/\.dinobot\/bin\/dinobot setup$/);
  });
});

describe("setup's edges", () => {
  it("Linux, while setup waits for Tailscale: the paste goes into a NEW terminal window", () => {
    const waiting = tailscaleSteps({ installed: false }, { os: "linux", waiting: true }).join("\n");
    assert.match(waiting, /open a NEW terminal window \(this one is waiting\)/);
    const stopped = tailscaleSteps({ installed: true, state: "Stopped" }, { os: "linux", waiting: true }).join("\n");
    assert.match(stopped, /In a NEW terminal window/);
    const notWaiting = tailscaleSteps({ installed: false }, { os: "linux", rerun: "x" }).join("\n");
    assert.doesNotMatch(notWaiting, /NEW terminal/);
  });
  it("sleep note: a Mac laptop always (lid), a Linux laptop on battery; desktops nothing", async () => {
    assert.match(await sleepNote({ os: "darwin", pmset: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;" }), /This Mac is a laptop/);
    assert.equal(await sleepNote({ os: "darwin", pmset: "Now drawing from 'AC Power'\n" }), null);
  });
});

describe("bare `dinobot`", () => {
  it("prints help (setup only as `dinobot setup`), with the update-instead-of-uninstall line", () => {
    const h = home();
    mkdirSync(h, { recursive: true });
    for (const argv of [[], ["help"], ["--help"]]) {
      const r = spawnSync(process.execPath, [join(HERE, "lib", "cli.mjs"), ...argv], { env: { PATH: process.env.PATH, HOME: h }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${USAGE.join("\n")}\n`);
    }
    assert.ok(USAGE.some((l) => /To update, run `dinobot update` \(or the install command again\): no need to uninstall\./.test(l)));
    assert.equal(existsSync(join(h, `.${PRODUCT_ID}`)), false, "nothing set up");
  });
});
