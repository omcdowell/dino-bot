// linux-ready: Linux-specific service behaviour. node --test test/linux.test.mjs
// (temp dirs under ./.test-tmp-linux, never /tmp)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { restartHint } from "../lib/doctor.mjs";
import { noServiceNote, startServices, uninstallServices, writeServices } from "../lib/service.mjs";
import { layout, PRODUCT_ID } from "../lib/util.mjs";

const require_cp = () => createRequire(import.meta.url)("node:child_process");
const TMP = join(import.meta.dirname, "..", ".test-tmp-linux");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("uninstall on systemd disables the units before deleting them", () => {
  it("disable --now (daemon, herdr, GC timer of the session), files gone, daemon-reload, reset-failed", async () => {
    const L = layout({ HOME: join(TMP, "h1") });
    const files = writeServices(L, "systemd");
    assert.ok(files.length >= 4 && files.every(existsSync));
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args.includes("disable")) assert.ok(files.every(existsSync), "disable runs while the unit files still exist");
      return { code: 0, stdout: "", stderr: "" };
    };
    await uninstallServices(L, "systemd", { session: "paseo-bots", exec });
    assert.ok(files.every((f) => !existsSync(f)), "unit files removed");
    const disable = calls.findIndex((c) => c.startsWith("systemctl --user disable --now"));
    assert.ok(disable >= 0, `no disable: ${calls.join(" | ")}`);
    for (const u of [`${PRODUCT_ID}.service`, `${PRODUCT_ID}-herdr.service`, `${PRODUCT_ID}-herdr-gc@paseo-bots.timer`]) assert.ok(calls[disable].includes(u), u);
    const reload = calls.indexOf("systemctl --user daemon-reload");
    assert.ok(reload > disable, "daemon-reload after the files are gone");
    assert.ok(calls.some((c) => c.startsWith("systemctl --user reset-failed")), "reset-failed");
  });
  it("launchd and none: no systemctl", async () => {
    const L = layout({ HOME: join(TMP, "h2") });
    const calls = [];
    await uninstallServices(L, "none", { exec: async (c, a) => (calls.push([c, ...a].join(" ")), { code: 0, stdout: "", stderr: "" }) });
    assert.deepEqual(calls.filter((c) => c.startsWith("systemctl")), []);
  });
});

describe("without systemd the restart hint is a command that works (dinobot is not on PATH)", () => {
  it("restartHint(none) and the start note use ~/.dinobot/bin/dinobot", () => {
    assert.equal(restartHint("none"), `~/.${PRODUCT_ID}/bin/${PRODUCT_ID} start`);
    const L = layout({ HOME: join(TMP, "h3") });
    assert.ok(noServiceNote(L).includes(`${join(L.bin, PRODUCT_ID)} start`), noServiceNote(L));
  });
});

// install.sh on minimal Linux systems (Debian/Fedora container images, linux-ready).
describe("install.sh on a minimal Linux", { skip: process.platform !== "linux" }, () => {
  const { execFileSync } = require_cp();
  const sh = join(import.meta.dirname, "..", "install.sh");
  // A PATH with only the listed tools (links to the real ones), plus fakes.
  function binDir(name, tools, fakes = {}) {
    const d = join(TMP, name);
    mkdirSync(d, { recursive: true });
    for (const t of tools) {
      const real = ["/usr/bin", "/bin"].map((p) => join(p, t)).find(existsSync);
      if (real) symlinkSync(real, join(d, t));
    }
    for (const [t, body] of Object.entries(fakes)) writeFileSync(join(d, t), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return d;
  }
  const BASE = ["sh", "uname", "tar", "mkdir", "cat", "cut", "tr", "grep", "sed", "date", "awk", "id", "getent", "sha256sum", "head", "ls", "rm", "mv", "cp", "chmod", "sleep", "env", "dirname"];
  function run(bin, home) {
    try {
      return { code: 0, out: execFileSync(join(bin, "sh"), [sh, "--yes"], { env: { PATH: bin, HOME: home, DINOBOT_NAME: "T" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  }
  it("no ps (procps): stops before downloading, with the package to install", () => {
    const h = join(TMP, "h-nops");
    const r = run(binDir("bin-nops", BASE), h);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no 'ps' command/);
    assert.match(r.out, /procps/);
    assert.equal(existsSync(join(h, `.${PRODUCT_ID}`)), false, "nothing written");
  });
  it("perl without Time::HiRes (perl-base) and no python3: the clock falls back to date", () => {
    const h = join(TMP, "h-perlbase");
    const r = run(binDir("bin-perlbase", [...BASE, "ps"], { perl: "echo \"Can't locate Time/HiRes.pm in @INC\" >&2; exit 2" }), h);
    assert.doesNotMatch(r.out, /HiRes/);
    // No curl or wget in this PATH: the download fails at once, after the clock (no network).
    assert.match(r.out, /Downloading\n[\s\S]*download of \S+ failed/, "got past the clock to the download");
  });
});

describe("no service manager: `dinobot start` while it is already running", () => {
  it("keeps the running daemon (no second one, pids.json still points at it)", async () => {
    const { spawn } = require_cp();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const L = layout({ HOME: join(TMP, "h4") });
    mkdirSync(L.root, { recursive: true });
    writeFileSync(L.envFile, "PASEO_LISTEN=127.0.0.1:1\n");
    const running = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      writeFileSync(join(L.root, "pids.json"), JSON.stringify({ daemon: running.pid }));
      // bin/paseo does not exist here: a spawn attempt would fail; the start must not try.
      const notes = await startServices(L, "none", { herdr: false });
      assert.equal(JSON.parse(readFileSync(join(L.root, "pids.json"), "utf8")).daemon, running.pid);
      assert.ok(notes.some((n) => /already running/.test(n)), notes.join("\n"));
    } finally {
      process.kill(-running.pid, "SIGKILL");
    }
  });
});
