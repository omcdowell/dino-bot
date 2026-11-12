// install.sh shows what it is doing from the very first moment (`curl … | sh` used to stay silent
// until the name question), and every slow step prints a line as it starts.
//   node --test test/install-feedback.test.mjs     (temp dirs under ./.test-tmp-feedback, never /tmp)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PRODUCT, PRODUCT_ID } from "../lib/util.mjs";

const HERE = join(import.meta.dirname, "..");
const SH = join(HERE, "install.sh");
const TMP = join(HERE, ".test-tmp-feedback");
mkdirSync(TMP, { recursive: true });
const tmp = () => mkdtempSync(join(TMP, "t-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "x64" ? "x64" : "arm64";
const FIRST = new RegExp(`^Installing ${PRODUCT}\\. This takes a minute or two`, "m");

/** A tarball shaped like ours whose "node" only says the wizard started. */
function fakeRelease(dir) {
  const name = `${PRODUCT_ID}-${OS}-${ARCH}`;
  const stage = join(dir, "stage", name);
  mkdirSync(join(stage, "node", "bin"), { recursive: true });
  mkdirSync(join(stage, "installer", "lib"), { recursive: true });
  writeFileSync(join(stage, "node", "bin", "node"), "#!/bin/sh\necho WIZARD-STARTED\n");
  chmodSync(join(stage, "node", "bin", "node"), 0o755);
  writeFileSync(join(stage, "installer", "lib", "cli.mjs"), "");
  const tar = join(dir, `${name}.tar.gz`);
  spawnSync("tar", ["-czf", tar, "-C", join(dir, "stage"), name]);
  writeFileSync(`${tar}.sha256`, `${createHash("sha256").update(readFileSync(tar)).digest("hex")}  ${name}.tar.gz\n`);
  return tar;
}

describe("install.sh: instant feedback", () => {
  it("the first line comes before any check: a 2 s `uname` does not delay it", async () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    // Everything from /usr/bin and /bin via PATH, except a slow uname (the first platform check).
    const real = ["/usr/bin/uname", "/bin/uname"].find(existsSync);
    writeFileSync(join(bin, "uname"), `#!/bin/sh\nsleep 2\nexec ${real} "$@"\n`, { mode: 0o755 });
    const t0 = Date.now();
    const child = spawn("sh", [SH, "--yes"], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: d, DINOBOT_HOME: join(d, ".dinobot"), DINOBOT_NAME: "T", DINOBOT_TARBALL: join(d, "missing.tar.gz"), DINOBOT_ALLOW_UNSIGNED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const first = new Promise((resolve) => child.stdout.on("data", (b) => { if (!out) resolve(Date.now() - t0); out += b; }));
    const done = new Promise((resolve) => child.on("close", () => resolve(Date.now() - t0)));
    const [tFirst, tDone] = [await first, await done];
    assert.match(out.split("\n")[0], FIRST, out);
    assert.ok(tDone >= 2000, `the slow uname ran (${tDone} ms)`);
    assert.ok(tFirst < 1000, `first output after ${tFirst} ms; it must not wait for the checks`);
  });

  it("also when the platform is refused (Windows Git Bash): the first line, then the reason", () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    for (const t of ["sh", "cat", "date", "perl", "python3"]) {
      const real = ["/usr/bin", "/bin"].map((p) => join(p, t)).find(existsSync);
      if (real) symlinkSync(real, join(bin, t));
    }
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0\n", { mode: 0o755 });
    const r = spawnSync(join(bin, "sh"), [SH, "--yes"], { env: { PATH: bin, HOME: d }, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, FIRST);
    assert.match(r.stderr, /runs inside WSL/);
  });

  it("every slow step says so as it starts, in order, before the wizard", () => {
    const d = tmp();
    const tar = fakeRelease(d);
    const r = spawnSync("sh", [SH, "--yes"], {
      env: { PATH: "/usr/bin:/bin", HOME: d, DINOBOT_HOME: join(d, ".dinobot"), DINOBOT_NAME: "T", DINOBOT_TARBALL: tar, DINOBOT_ALLOW_UNSIGNED: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.split("\n");
    assert.match(lines[0], FIRST);
    const steps = [/^Checking this computer/, /^Downloading \S+ \(\S+\) in the background/, /^Downloading\.* done/, /^Checking the download/, /^Unpacking/, /^Starting the setup wizard/, /^WIZARD-STARTED/];
    let at = 0;
    for (const s of steps) {
      const i = lines.findIndex((l, j) => j >= at && s.test(l));
      assert.ok(i >= at, `${s} after line ${at}:\n${r.stdout}`);
      at = i + 1;
    }
  });

  // The name question needs a terminal: script(1) gives it one (util-linux on Linux).
  it("the name question comes after the download started and says so", { skip: process.platform !== "linux" || !existsSync("/usr/bin/script") }, () => {
    const d = tmp();
    const tar = fakeRelease(d);
    const env = { PATH: "/usr/bin:/bin", HOME: d, DINOBOT_HOME: join(d, ".dinobot"), DINOBOT_TARBALL: tar, DINOBOT_ALLOW_UNSIGNED: "1", TERM: "dumb" };
    const r = spawnSync("script", ["-qec", `sh ${SH}`, "/dev/null"], { env, input: "Ada\n", encoding: "utf8", timeout: 60_000 });
    const out = r.stdout.replace(/\r/g, "");
    const started = out.search(/Downloading \S+ \(\S+\) in the background/);
    const asked = out.search(/While that downloads: what should your bots call you\? \[/);
    assert.ok(started >= 0 && asked > started, out);
    // (The terminal echoes the typed "Ada" at the top: the input was queued before the script ran.)
    assert.ok(out.search(FIRST) >= 0 && out.search(FIRST) < out.search(/^Checking this computer/m), out);
    assert.match(out, /--name Ada|WIZARD-STARTED/);
  });
});
