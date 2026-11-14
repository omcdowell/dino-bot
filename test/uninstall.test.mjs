// `dinobot uninstall` (removes ~/.dinobot incl. sign-ins; keeps bots/memories) and
// `uninstall --purge` (full wipe, DELETE prompt, --yes, non-TTY refusal, HOME guard).
// node --test test/uninstall.test.mjs   (temp HOMEs under ./.test-tmp-uninstall, never the real HOME)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, afterEach, describe, it } from "node:test";
import { LINGER_MARK, uninstallServices, writeServices } from "../lib/service.mjs";
import { diskSize, humanSize, uninstall, uninstallTargets, unsafeReason } from "../lib/uninstall.mjs";
import { layout, PRODUCT_ID } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-uninstall");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  process.exitCode = 0;
});

let n = 0;
const put = (p, text = "x") => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const tryPut = (p, text) => {
  try {
    put(p, text);
  } catch {} // e.g. OPTCHAT_HOME=/ in the guard tests
};

/** A fake install in a throwaway HOME: everything uninstall knows about, plus a file of the user's. */
function fakeInstall(extraEnv = {}) {
  const home = extraEnv.HOME ?? join(TMP, `h${++n}`);
  const env = { HOME: home, ...extraEnv };
  const L = layout(env);
  put(join(L.app, "daemon", "bin", "paseo"), "#!/bin/sh\n");
  put(join(L.bin, PRODUCT_ID), "#!/bin/sh\n");
  put(join(L.piAgentDir, "auth.json"), '{"anthropic":{"type":"oauth"}}');
  put(L.envFile, `PASEO_PASSWORD=pw\nPASEO_BOTS_ROOT=${L.botsRoot}\n`);
  put(L.state, JSON.stringify({ serviceMode: "none", herdrSession: "paseo-bots", herdrSocketDir: join(home, "sock") }));
  put(join(home, "sock", "herdr-client.sock"), "");
  tryPut(join(L.botsRoot, "luna", "MEMORY.md"), "memories");
  tryPut(join(L.optchatHome, "profiles", "luna", "AGENTS.md"), "profile");
  put(join(home, ".local", "state", "bot-rooms", "g1", "log.jsonl"), "{}");
  put(join(home, ".local", "state", "bot-dm", "launches.jsonl"), "{}");
  put(join(home, ".config", "herdr", "sessions", "paseo-bots", "config.toml"), "");
  put(join(home, ".local", "state", "herdr", "x.log"), "");
  put(join(home, "Documents", "mine.txt"), "the user's own file");
  put(join(home, ".pi", "agent", "auth.json"), "{}"); // the user's own pi: never touched
  return { home, env, L };
}

function deps(env, extra = {}) {
  const calls = [];
  const out = { text: "", write(s) { this.text += s; } };
  return {
    calls,
    out,
    d: {
      env,
      out,
      mode: "none",
      wsl: null,
      stop: async (_L, mode) => calls.push(`stop ${mode}`),
      removeServices: async (_L, mode, o) => calls.push(`remove ${mode} ${o.session}`),
      exec: async (c, a) => (calls.push([c, ...a].join(" ")), { code: 0, stdout: "", stderr: "" }),
      ...extra,
    },
  };
}

const ALL = (home) => [
  "sock",
  ".dinobot",
  "bots",
  ".optchat",
  ".local/state/bot-rooms",
  ".local/state/bot-dm",
  ".config/herdr",
  ".local/state/herdr",
].map((p) => join(home, p));

describe("uninstall (no flag): what --purge used to do", () => {
  it("removes services, herdr sockets and all of ~/.dinobot (sign-ins too); keeps bots, memories, rooms, herdr", async () => {
    const { home, env, L } = fakeInstall();
    const { d, calls, out } = deps(env);
    const r = await uninstall(L, {}, d);
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ["stop none", "remove none paseo-bots"]);
    assert.equal(existsSync(L.root), false, "~/.dinobot gone");
    assert.equal(existsSync(join(home, "sock")), false, "herdr socket dir gone");
    for (const kept of ALL(home).slice(2)) assert.equal(existsSync(kept), true, `${kept} kept`);
    assert.equal(existsSync(join(home, "Documents", "mine.txt")), true);
    assert.equal(existsSync(join(home, ".pi", "agent", "auth.json")), true);
    assert.match(out.text, /sign-ins are removed/);
    assert.match(out.text, /bots .* and memories .* are kept/);
    assert.match(out.text, /uninstall --purge/);
    assert.doesNotMatch(out.text, /DELETE/, "no prompt without --purge");
  });
});

describe("uninstall --purge: full wipe", () => {
  it("--yes: lists the paths with sizes, deletes all of them, keeps the rest of HOME", async () => {
    const { home, env, L } = fakeInstall();
    const { d, out } = deps(env);
    const r = await uninstall(L, { purge: true, yes: true }, d);
    assert.equal(r.ok, true);
    for (const p of ALL(home)) {
      assert.match(out.text, new RegExp(`\\d[\\d.]* (B|KB|MB)  ${p.replace(/[.]/g, "\\.")}  `), `listed with size: ${p}`);
      assert.equal(existsSync(p), false, `${p} gone`);
    }
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(join(home, "Documents", "mine.txt")), true);
    assert.equal(existsSync(join(home, ".pi", "agent", "auth.json")), true);
    assert.equal(existsSync(join(home, ".config")), true, "only ~/.config/herdr, not ~/.config");
    assert.match(out.text, /wiped/);
  });

  it("at a terminal: deletes only after DELETE is typed", async () => {
    const { home, env, L } = fakeInstall();
    const input = new PassThrough();
    const { d, out, calls } = deps(env, { input, isTTY: true });
    const p = uninstall(L, { purge: true }, d);
    setTimeout(() => input.end("DELETE\n"), 20);
    const r = await p;
    assert.equal(r.ok, true);
    assert.match(out.text, /Type DELETE/);
    assert.ok(calls.includes("stop none"));
    for (const x of ALL(home)) assert.equal(existsSync(x), false, `${x} gone`);
  });

  it("at a terminal: anything but DELETE changes nothing (services not even stopped)", async () => {
    for (const typed of ["delete\n", "y\n", "\n", ""]) {
      const { home, env, L } = fakeInstall();
      const input = new PassThrough();
      const { d, out, calls } = deps(env, { input, isTTY: true });
      const p = uninstall(L, { purge: true }, d);
      setTimeout(() => input.end(typed), 10);
      const r = await p;
      assert.equal(r.ok, false);
      assert.equal(r.refused, "not-confirmed");
      assert.equal(process.exitCode, 1);
      assert.deepEqual(calls, []);
      assert.match(out.text, /Nothing was changed/);
      for (const x of ALL(home)) assert.equal(existsSync(x), true, `${x} kept (typed ${JSON.stringify(typed)})`);
    }
  });

  it("no terminal and no --yes: refuses, changes nothing", async () => {
    const { home, env, L } = fakeInstall();
    const { d, out, calls } = deps(env, { isTTY: false, input: new PassThrough() });
    const r = await uninstall(L, { purge: true }, d);
    assert.equal(r.refused, "no-tty");
    assert.equal(process.exitCode, 1);
    assert.deepEqual(calls, []);
    assert.match(out.text, /--purge --yes/);
    for (const x of ALL(home)) assert.equal(existsSync(x), true);
  });

  it("never follows symlinks out of the listed paths", async () => {
    const { home, env, L } = fakeInstall();
    const outside = join(TMP, `outside${n}`);
    put(join(outside, "precious.txt"), "keep");
    symlinkSync(outside, join(L.botsRoot, "luna", "link-out")); // inside a listed dir
    // the bots folder itself a symlink to a folder outside: the link goes, the folder stays
    const realBots = join(TMP, `realbots${n}`);
    put(join(realBots, "b", "MEMORY.md"), "m");
    rmSync(L.optchatHome, { recursive: true });
    symlinkSync(realBots, L.optchatHome);
    const { d } = deps(env);
    await uninstall(L, { purge: true, yes: true }, d);
    assert.equal(existsSync(join(outside, "precious.txt")), true);
    assert.equal(existsSync(join(realBots, "b", "MEMORY.md")), true);
    assert.equal(existsSync(L.optchatHome), false);
    assert.equal(existsSync(L.botsRoot), false);
  });

  it("uses the bots folder from daemon.env too (PASEO_BOTS_ROOT set at setup, not now)", async () => {
    const { home, env, L } = fakeInstall();
    const other = join(home, "elsewhere-bots");
    put(join(other, "x", "MEMORY.md"));
    put(L.envFile, `PASEO_BOTS_ROOT=${other}\n`);
    const { d } = deps(env);
    await uninstall(L, { purge: true, yes: true }, d);
    assert.equal(existsSync(other), false);
  });
});

describe("HOME guard", () => {
  it("unsafeReason: HOME, /, a folder above HOME, relative paths, and HOME via a symlinked parent", () => {
    const home = join(TMP, "guard-home");
    mkdirSync(home, { recursive: true });
    assert.match(unsafeReason(home, home), /home folder/);
    assert.match(unsafeReason(`${home}/`, home), /home folder/);
    assert.match(unsafeReason(join(home, "bots", ".."), home), /home folder/);
    assert.match(unsafeReason("/", home), /is \//);
    assert.match(unsafeReason(dirname(home), home), /contains your home/);
    assert.match(unsafeReason("bots", home), /absolute/);
    assert.equal(unsafeReason(join(home, "bots"), home), null);
    assert.equal(unsafeReason(join(home, "bots-and-more"), home), null);
    const alias = join(TMP, "alias-parent");
    symlinkSync(dirname(home), alias);
    assert.match(unsafeReason(join(alias, "guard-home"), home), /home folder/, "parent symlink resolved");
  });

  for (const [what, extra] of [
    ["PASEO_BOTS_ROOT=HOME", (h) => ({ PASEO_BOTS_ROOT: h })],
    ["OPTCHAT_HOME=/", () => ({ OPTCHAT_HOME: "/" })],
    ["DINOBOT_HOME above HOME", (h) => ({ DINOBOT_HOME: dirname(h) })],
  ]) {
    it(`refuses the whole uninstall when a path is unsafe (${what}); nothing deleted`, async () => {
      const home = join(TMP, `h${++n}`);
      const { env, L } = fakeInstall({ HOME: home, ...extra(home) });
      const { d, out, calls } = deps(env);
      const r = await uninstall(L, { purge: true, yes: true }, d);
      assert.equal(r.refused, "unsafe");
      assert.equal(process.exitCode, 1);
      assert.deepEqual(calls, []);
      assert.match(out.text, /Refusing/);
      assert.equal(existsSync(join(home, "Documents", "mine.txt")), true);
      assert.equal(existsSync(join(home, ".local", "state", "bot-rooms")), true);
    });
  }

  it("plain uninstall is guarded too (DINOBOT_HOME=HOME)", async () => {
    const home = join(TMP, `h${++n}`);
    const { env, L } = fakeInstall({ HOME: home, DINOBOT_HOME: home });
    const { d } = deps(env);
    const r = await uninstall(L, {}, d);
    assert.equal(r.refused, "unsafe");
    assert.equal(existsSync(join(home, "Documents", "mine.txt")), true);
  });
});

describe("targets and sizes", () => {
  it("plain: sockets + ~/.dinobot; purge adds bots, memories, rooms, bot-dm, herdr; missing paths skipped", () => {
    const { home, env, L } = fakeInstall();
    const state = { herdrSocketDir: join(home, "sock") };
    assert.deepEqual(uninstallTargets(L, { env, state }).map((t) => t.path), [join(home, "sock"), L.root]);
    rmSync(join(home, ".local", "state", "herdr"), { recursive: true });
    assert.deepEqual(uninstallTargets(L, { purge: true, env, state }).map((t) => t.path), ALL(home).filter((p) => !p.endsWith("state/herdr")));
  });

  it("XDG_CONFIG_HOME / XDG_STATE_HOME / PASEO_BOTS_ROOMS are honoured", () => {
    const { home, L } = fakeInstall();
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, "cfg"), XDG_STATE_HOME: join(home, "st"), PASEO_BOTS_ROOMS: join(home, "rooms") };
    for (const p of ["cfg/herdr", "st/herdr", "st/bot-dm", "rooms"]) put(join(home, p, "f"));
    const paths = uninstallTargets(L, { purge: true, env }).map((t) => t.path);
    for (const p of ["cfg/herdr", "st/herdr", "st/bot-dm", "rooms"]) assert.ok(paths.includes(join(home, p)), p);
    assert.ok(!paths.includes(join(home, ".config", "herdr")));
  });

  it("XDG_* / PASEO_BOTS_ROOMS outside HOME are ignored (a test HOME never reaches the real account's dirs)", () => {
    const { home, L } = fakeInstall();
    const real = join(TMP, `real-account${n}`);
    for (const p of ["cfg/herdr", "st/herdr", "st/bot-dm", "rooms"]) put(join(real, p, "f"));
    const env = { HOME: home, XDG_CONFIG_HOME: join(real, "cfg"), XDG_STATE_HOME: join(real, "st"), PASEO_BOTS_ROOMS: join(real, "rooms") };
    const paths = uninstallTargets(L, { purge: true, env }).map((t) => t.path);
    assert.ok(paths.every((p) => p.startsWith(home + "/")), paths.join(" "));
    assert.ok(paths.includes(join(home, ".config", "herdr")));
  });

  it("diskSize counts bytes without following symlinks; humanSize", () => {
    const d = join(TMP, "size");
    put(join(d, "a"), "12345");
    put(join(d, "sub", "b"), "123");
    const big = join(TMP, "size-big");
    put(join(big, "f"), "x".repeat(10_000));
    symlinkSync(big, join(d, "link"));
    const n = diskSize(d);
    assert.ok(n >= 8 && n < 1000, String(n));
    assert.equal(humanSize(512), "512 B");
    assert.equal(humanSize(2048), "2.0 KB");
    assert.equal(humanSize(50 * 1024 * 1024), "50 MB");
  });
});

describe("linger: off only when setup turned it on", () => {
  const lingerExec = (calls, on = true) => async (c, a) => {
    calls.push([c, ...a].join(" "));
    return { code: 0, stdout: c === "loginctl" && a[0] === "show-user" ? `Linger=${on ? "yes" : "no"}\n` : "", stderr: "" };
  };

  it("setup's mark present: loginctl disable-linger (no sudo)", async () => {
    const { env, L } = fakeInstall({ USER: "friend" });
    put(join(L.root, LINGER_MARK), "2025-11-14\n");
    const { d, calls, out } = deps(env, { mode: "systemd" });
    d.exec = lingerExec(calls);
    await uninstall(L, { purge: true, yes: true }, d);
    assert.ok(calls.includes("loginctl disable-linger friend"));
    assert.ok(!calls.some((c) => /sudo/.test(c)));
    assert.match(out.text, /Linger turned off/);
  });

  it("no mark (unknown who turned it on): prints the command, does not run it", async () => {
    const { env, L } = fakeInstall({ USER: "friend" });
    const { d, calls, out } = deps(env, { mode: "systemd" });
    d.exec = lingerExec(calls);
    await uninstall(L, { purge: true, yes: true }, d);
    assert.ok(!calls.includes("loginctl disable-linger friend"));
    assert.match(out.text, /loginctl disable-linger friend/);
  });

  it("plain uninstall leaves linger alone", async () => {
    const { env, L } = fakeInstall({ USER: "friend" });
    put(join(L.root, LINGER_MARK), "x");
    const { d, calls } = deps(env, { mode: "systemd" });
    d.exec = lingerExec(calls);
    await uninstall(L, {}, d);
    assert.ok(!calls.some((c) => c.startsWith("loginctl")));
  });
});

describe("WSL: the Windows sign-in start is undone", () => {
  it("calls wsl-autostart --off on WSL, both modes", async () => {
    for (const args of [{}, { purge: true, yes: true }]) {
      const { env, L } = fakeInstall();
      const seen = [];
      const { d } = deps(env, { wsl: { version: 2 }, wslAutostart: async (_L, o) => seen.push(o.off) });
      await uninstall(L, args, d);
      assert.deepEqual(seen, [true]);
    }
  });
});

describe("macOS: launchd agents are removed", () => {
  it("uninstallServices(launchd) deletes the plists in ~/Library/LaunchAgents (bootout is stopServices')", async () => {
    const L = layout({ HOME: join(TMP, `mac${++n}`) });
    writeServices(L, "launchd");
    const dir = join(L.home, "Library", "LaunchAgents");
    const files = await uninstallServices(L, "launchd", { exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    assert.equal(files.length, 3);
    for (const f of files) {
      assert.ok(f.startsWith(dir));
      assert.equal(existsSync(f), false);
    }
  });
});
