// install.sh's two looks (see the RICH comment in install.sh and lib/tui.mjs): at a real terminal
// steps, a progress line redrawn in place and details in logs/install.log; piped or TERM=dumb the
// plain lines as before. Every window size we design for, from macOS Terminal's 80×24 to 240×70.
//   node --test test/tui-install.test.mjs     (Linux: script(1) gives the installer a terminal)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PRODUCT, PRODUCT_ID } from "../lib/util.mjs";

const HERE = join(import.meta.dirname, "..");
const SH = join(HERE, "install.sh");
const TMP = join(HERE, ".test-tmp-tui-install");
mkdirSync(TMP, { recursive: true });
const tmp = () => mkdtempSync(join(TMP, "t-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "x64" ? "x64" : "arm64";
const TTY = process.platform === "linux" && existsSync("/usr/bin/script");
const SIZES = { "mac-default": [80, 24], "small-linux": [100, 30], medium: [120, 40], large: [160, 50], huge: [240, 70], "too-narrow": [60, 20] };

function fakeRelease(dir, { pad = 0, badSum = false } = {}) {
  const name = `${PRODUCT_ID}-${OS}-${ARCH}`;
  const stage = join(dir, "stage", name);
  mkdirSync(join(stage, "node", "bin"), { recursive: true });
  mkdirSync(join(stage, "installer", "lib"), { recursive: true });
  writeFileSync(join(stage, "node", "bin", "node"), "#!/bin/sh\necho WIZARD-STARTED\n");
  chmodSync(join(stage, "node", "bin", "node"), 0o755);
  writeFileSync(join(stage, "installer", "lib", "cli.mjs"), "");
  if (pad) writeFileSync(join(stage, "pad.bin"), randomBytes(pad));
  const tar = join(dir, `${name}.tar.gz`);
  spawnSync("tar", ["-czf", tar, "-C", join(dir, "stage"), name]);
  const sum = badSum ? "0".repeat(64) : createHash("sha256").update(readFileSync(tar)).digest("hex");
  writeFileSync(`${tar}.sha256`, `${sum}  ${name}.tar.gz\n`);
  return tar;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("close", (code) => resolve({ code, out }));
  });
}
/** install.sh in a pty of cols × rows (script(1); stty sets the size the installer reads). */
const inTerminal = (env, cols, rows, extra = "--yes") => run("script", ["-qec", `stty cols ${cols} rows ${rows}; sh ${SH} ${extra}`, "/dev/null"], env);
const baseEnv = (d, tarball, more = {}) => ({ PATH: "/usr/bin:/bin", HOME: d, DINOBOT_HOME: join(d, ".dinobot"), DINOBOT_NAME: "T", DINOBOT_TARBALL: tarball, DINOBOT_ALLOW_UNSIGNED: "1", TERM: "xterm-256color", ...more });

const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
/** What stays on screen: each line's text after its last \r (a redrawn line shows its last draw). */
const screenLines = (out) => strip(out).split("\n").map((l) => l.replace(/\r$/, "").split("\r").pop());
const width = (s) => [...s].length;

describe("install.sh at a terminal (rich look)", { skip: !TTY }, () => {
  for (const [name, [cols, rows]] of Object.entries(SIZES)) {
    it(`${name} ${cols}×${rows}: steps, nothing wider than the window, details in the log`, async () => {
      const d = tmp();
      const tar = fakeRelease(d, { pad: 1048576 });
      const r = await inTerminal(baseEnv(d, tar), cols, rows);
      assert.equal(r.code, 0, r.out);
      const lines = screenLines(r.out);
      for (const l of lines) assert.ok(width(l) <= cols, `${width(l)} > ${cols}: ${JSON.stringify(l)}`);
      assert.ok(lines.some((l) => /^ {2}Step 1 of 3 {2}Download$/.test(l)), r.out);
      assert.ok(lines.some((l) => /^ {2}✓ Downloaded \(1 MB\)$/.test(l)), r.out);
      assert.ok(lines.some((l) => /^ {2}✓ Unpacked$/.test(l)), r.out);
      // the install path and the per-step lines went to the log, not the screen
      assert.doesNotMatch(strip(r.out), /in the background into|Unpacking into|Starting the setup wizard/);
      const log = readFileSync(join(d, ".dinobot", "logs", "install.log"), "utf8");
      assert.match(log, /Downloading \S+ \(\S+\) in the background into/);
      assert.match(log, /Unpacking into/);
      assert.match(r.out, /WIZARD-STARTED/);
    });
  }

  it("a progress line redrawn in place never wraps, even in a 60-column window", async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 3 * 1048576 });
    const r = await inTerminal(baseEnv(d, tar), 60, 20);
    assert.equal(r.code, 0, r.out);
    for (const part of strip(r.out).split(/[\r\n]/)) assert.ok(width(part) <= 60, `${width(part)}: ${JSON.stringify(part)}`);
  });

  it("NO_COLOR: the same layout without colour codes", async () => {
    const d = tmp();
    const tar = fakeRelease(d);
    const r = await inTerminal(baseEnv(d, tar, { NO_COLOR: "1" }), 80, 24);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /\u001b\[[0-9;]*m/, "no SGR colour codes");
    assert.match(r.out, /Step 1 of 3 {2}Download/);
  });

  it("a failure: one sentence, the next step, the log path; curl's noise only in the log", async () => {
    const d = tmp();
    const tar = fakeRelease(d, { badSum: true });
    const r = await inTerminal(baseEnv(d, tar), 80, 24);
    assert.notEqual(r.code, 0);
    const text = screenLines(r.out).join("\n");
    assert.match(text, /✗ DinoBot install stopped\./);
    assert.match(text, /The download does not match its checksum/);
    assert.match(text, /Details: ~\/\.dinobot\/logs\/install\.log/);
    for (const l of screenLines(r.out)) assert.ok(width(l) <= 80, l);
  });
});

describe("install.sh piped or TERM=dumb: the plain lines, as before", () => {
  it("piped: no step headers, no colour, no carriage returns", async () => {
    const d = tmp();
    const tar = fakeRelease(d);
    const r = await run("sh", [SH, "--yes"], baseEnv(d, tar));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out.split("\n")[0], new RegExp(`^Installing ${PRODUCT}\\. This takes a minute or two`));
    assert.doesNotMatch(r.out, /Step 1 of 3|\u001b|\r/);
    assert.match(r.out, /^Unpacking into /m);
  });
  it("TERM=dumb at a terminal: the plain lines", { skip: !TTY }, async () => {
    const d = tmp();
    const tar = fakeRelease(d);
    const r = await inTerminal(baseEnv(d, tar, { TERM: "dumb" }), 80, 24);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Step 1 of 3/);
    assert.match(r.out, /Unpacking into /);
  });
});
