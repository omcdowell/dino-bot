// The optional push add-on (lib/push.mjs, addons/paseo-apns): shipped, but off unless turned on.
// node --test test/push.test.mjs  (temp dirs under ./.test-tmp-push, never /tmp: its own folder, as unit.test.mjs removes ./.test-tmp)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { readEnvFile, writeDaemonConfig, writeDaemonEnv, writeWrappers } from "../lib/config.mjs";
import { APNS_PLUGIN_ID, disablePush, enablePush, pushConfig, pushEndpoint, pushState } from "../lib/push.mjs";
import { layout } from "../lib/util.mjs";

const ROOT = join(import.meta.dirname, "..");
const ADDON = join(ROOT, "addons", "paseo-apns");
const TMP = join(ROOT, ".test-tmp-push");
mkdirSync(TMP, { recursive: true });
const tmp = () => mkdtempSync(join(TMP, "push-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** An installed layout: daemon env and config as setup writes them, the add-on unpacked in app/apns. */
function installed({ bundled = true } = {}) {
  const L = layout({ HOME: tmp() });
  mkdirSync(L.app, { recursive: true });
  writeDaemonEnv(L, { port: 6767, listen: "100.64.0.7:6767", directEndpoints: [] });
  writeDaemonConfig(L, { mainModel: null });
  if (bundled) cpSync(ADDON, join(L.app, "apns"), { recursive: true });
  return L;
}
const daemonConfig = (L) => JSON.parse(readFileSync(join(L.paseoHome, "config.json"), "utf8"));
const mode = (p) => statSync(p).mode & 0o777;
/** A stand-in key file nobody can read: enable must never need to open it. */
function fakeKey(dir) {
  const p = join(dir, "AuthKey_fake.p8");
  writeFileSync(p, "not a key\n");
  chmodSync(p, 0o000);
  return p;
}
const KEY = { keyId: "ABCDE12345", teamId: "TEAM123456", topic: "com.example.dinobot" };

describe("push add-on: off by default", () => {
  it("the add-on is in the repo as files only (no history, tests or node_modules) with its licence", () => {
    const files = [];
    const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : files.push(relative(ADDON, join(d, e.name)))));
    walk(ADDON);
    assert.ok(!files.some((f) => /(^|\/)(\.git|test|node_modules)(\/|$)/.test(f)), files.join(" "));
    for (const f of ["paseo-plugin.json", "index.server.ts", "LICENSE", "NOTICE", "package.json"]) assert.ok(files.includes(f), f);
    assert.equal(JSON.parse(readFileSync(join(ADDON, "paseo-plugin.json"), "utf8")).id, APNS_PLUGIN_ID);
    // build-tarball.sh copies the package.json "files" list (+ package.json): every file is in it.
    const listed = JSON.parse(readFileSync(join(ADDON, "package.json"), "utf8")).files.map((f) => f.replace(/\/$/, ""));
    for (const f of files) assert.ok(f === "package.json" || listed.some((l) => f === l || f.startsWith(`${l}/`)), `${f} not in files`);
  });

  it("build-tarball.sh stages it as apns/ (notices.mjs then needs apns/LICENSE)", () => {
    const sh = readFileSync(join(ROOT, "build", "build-tarball.sh"), "utf8");
    assert.match(sh, /\$HERE\/addons\/paseo-apns/);
    assert.match(sh, /\$STAGE\/apns/);
    assert.match(readFileSync(join(ROOT, "build", "notices.mjs"), "utf8"), /apns: "LICENSE"/);
  });

  it("a stock install: plugin bundled but not registered, no PASEO_APNS_DIR, status says off", () => {
    const L = installed();
    const cfg = daemonConfig(L);
    assert.equal(cfg.plugins.bots.enabled, true);
    assert.equal(cfg.plugins[APNS_PLUGIN_ID], undefined);
    assert.equal(readEnvFile(L.envFile).PASEO_APNS_DIR, undefined);
    const st = pushState(L);
    assert.equal(st.bundled, true);
    assert.equal(st.enabled, false);
    assert.equal(st.registered, false);
    assert.equal(existsSync(join(L.root, "apns")), false);
  });

  it("bot-dm's wrapper sets PASEO_APNS_DIR only once ~/.dinobot/apns exists", () => {
    const L = installed();
    writeWrappers(L);
    const probe = (extra = {}) =>
      execFileSync("sh", ["-c", `${readFileSync(join(L.bin, "bot-dm"), "utf8").replace(/^exec .*$/m, 'echo "dir=$PASEO_APNS_DIR"')}`], { env: { PATH: process.env.PATH, ...extra }, encoding: "utf8" }).trim();
    assert.equal(probe(), "dir=");
    mkdirSync(join(L.root, "apns"));
    assert.equal(probe(), `dir=${join(L.root, "apns")}`);
    assert.equal(probe({ PASEO_APNS_DIR: "/elsewhere" }), "dir=/elsewhere");
  });
});

describe("push add-on: dinobot push enable / disable", () => {
  it("enable with your own key: config (600, key by path only), token, plugin on, PASEO_APNS_DIR", () => {
    const L = installed();
    const keyPath = fakeKey(L.home);
    const done = enablePush(L, { keyPath, ...KEY });
    const dir = join(L.root, "apns");
    assert.equal(done.dir, dir);
    const conf = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(conf, { mode: "apns", keyPath, ...KEY, port: 6790, rateLimit: { windowSeconds: 600, perSender: true }, jwtReuseMinutes: 40 });
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, "config.json")), 0o600);
    assert.equal(mode(join(dir, "notify-token")), 0o600);
    assert.match(readFileSync(join(dir, "notify-token"), "utf8"), /^[0-9a-f]{64}\n$/);
    assert.equal(done.keyMode, 0o000); // stat only; the 000 key was never opened
    assert.deepEqual(daemonConfig(L).plugins[APNS_PLUGIN_ID], { source: "directory", path: join(L.app, "apns"), enabled: true });
    assert.equal(daemonConfig(L).plugins.bots.enabled, true);
    assert.equal(readEnvFile(L.envFile).PASEO_APNS_DIR, dir);
    assert.equal(mode(L.envFile), 0o600);
    assert.deepEqual({ ...pushState(L), dir: null }, { bundled: true, enabled: true, registered: true, dir: null, mode: "apns", topic: KEY.topic, port: 6790, phones: 0 });
  });

  it("setup running again keeps the add-on registered and PASEO_APNS_DIR", () => {
    const L = installed();
    enablePush(L, { keyPath: fakeKey(L.home), ...KEY });
    const pw = readEnvFile(L.envFile).PASEO_PASSWORD;
    writeDaemonEnv(L, { port: 6767, listen: "100.64.0.7:6767", directEndpoints: [] });
    writeDaemonConfig(L, { mainModel: null });
    assert.equal(readEnvFile(L.envFile).PASEO_APNS_DIR, join(L.root, "apns"));
    assert.equal(readEnvFile(L.envFile).PASEO_PASSWORD, pw);
    assert.equal(daemonConfig(L).plugins[APNS_PLUGIN_ID].enabled, true);
  });

  it("enable --local: no key needed, mode local", () => {
    const L = installed();
    enablePush(L, { local: true });
    assert.deepEqual(JSON.parse(readFileSync(join(L.root, "apns", "config.json"), "utf8")), { mode: "local", port: 6790, rateLimit: { windowSeconds: 600, perSender: true } });
    assert.equal(pushState(L).mode, "local");
    assert.equal(pushState(L).enabled, true);
  });

  it("disable turns the plugin off and keeps its files; enable again turns it back on", () => {
    const L = installed();
    assert.deepEqual(disablePush(L), { changed: false }); // never enabled: nothing to do
    enablePush(L, { local: true });
    const token = readFileSync(join(L.root, "apns", "notify-token"), "utf8");
    assert.deepEqual(disablePush(L), { changed: true });
    assert.equal(daemonConfig(L).plugins[APNS_PLUGIN_ID].enabled, false);
    assert.equal(pushState(L).enabled, false);
    assert.ok(existsSync(join(L.root, "apns", "config.json")));
    enablePush(L, { local: true });
    assert.equal(daemonConfig(L).plugins[APNS_PLUGIN_ID].enabled, true);
    assert.equal(readFileSync(join(L.root, "apns", "notify-token"), "utf8"), token); // same token: bot-dm keeps working
  });

  it("refuses bad or missing values and writes nothing", () => {
    const L = installed();
    const keyPath = fakeKey(L.home);
    const bad = [
      [{}, /missing --key-path, --key-id, --team-id, --topic/],
      [{ ...KEY, keyPath: "AuthKey.p8" }, /absolute path/],
      [{ ...KEY, keyPath: join(L.home, "nope.p8") }, /no key file/],
      [{ ...KEY, keyPath, keyId: "short" }, /key ID/],
      [{ ...KEY, keyPath, teamId: "lower12345" }, /Team ID/],
      [{ ...KEY, keyPath, topic: "com.example/app" }, /bundle id/],
      [{ local: true, port: "80" }, /--port/],
    ];
    for (const [opts, re] of bad) assert.throws(() => enablePush(L, opts), re);
    assert.equal(existsSync(join(L.root, "apns")), false);
    assert.equal(daemonConfig(L).plugins[APNS_PLUGIN_ID], undefined);
  });

  it("refuses on an install without the add-on (older tarball)", () => {
    const L = installed({ bundled: false });
    assert.throws(() => enablePush(L, { local: true }), /no push add-on.*dinobot update/);
    assert.equal(pushState(L).bundled, false);
  });

  it("pushConfig: a port given as text (from the command line) is a number", () => {
    const c = pushConfig({ keyPath: "/k/AuthKey_fake.p8", ...KEY, port: "7000" }, { exists: () => true, stat: () => ({ isFile: () => true }) });
    assert.equal(c.port, 7000);
  });

  it("status/test talk to the add-on's 127.0.0.1 endpoint with the notify token", async () => {
    const L = installed();
    assert.match((await pushEndpoint(L)).message, /not set up/);
    enablePush(L, { local: true, port: "7001" });
    const token = readFileSync(join(L.root, "apns", "notify-token"), "utf8").trim();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method ?? "GET", auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
      return { ok: false, status: 409, json: async () => ({ ok: false, code: "push_off" }) };
    };
    await pushEndpoint(L, { fetchImpl });
    const r = await pushEndpoint(L, { test: true, fetchImpl });
    assert.equal(r.body.code, "push_off");
    assert.deepEqual(calls.map((c) => [c.url, c.method, c.auth]), [
      ["http://127.0.0.1:7001/status", "GET", `Bearer ${token}`],
      ["http://127.0.0.1:7001/notify", "POST", `Bearer ${token}`],
    ]);
    assert.equal(calls[1].body.sender, "dinobot");
    const down = await pushEndpoint(L, { fetchImpl: async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); } });
    assert.match(down.message, /does not answer on http:\/\/127\.0\.0\.1:7001 \(ECONNREFUSED\)/);
  });
});
