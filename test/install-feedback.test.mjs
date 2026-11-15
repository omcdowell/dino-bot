// install.sh shows what it is doing from the very first moment (`curl … | sh` used to stay silent
// until the name question), and every slow step prints a line as it starts.
//   node --test test/install-feedback.test.mjs     (temp dirs under ./.test-tmp-feedback, never /tmp)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { chmodSync, existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
function fakeRelease(dir, { pad = 0 } = {}) {
  const name = `${PRODUCT_ID}-${OS}-${ARCH}`;
  const stage = join(dir, "stage", name);
  mkdirSync(join(stage, "node", "bin"), { recursive: true });
  mkdirSync(join(stage, "installer", "lib"), { recursive: true });
  writeFileSync(join(stage, "node", "bin", "node"), "#!/bin/sh\necho WIZARD-STARTED\n");
  chmodSync(join(stage, "node", "bin", "node"), 0o755);
  writeFileSync(join(stage, "installer", "lib", "cli.mjs"), "");
  // Incompressible padding: a download big enough for the progress bar to show.
  if (pad) writeFileSync(join(stage, "pad.bin"), randomBytes(pad));
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

const isFile = (f) => existsSync(f) && statSync(f).isFile();

// The main download's progress bar. A stand-in release server on 127.0.0.1 sends the tarball slowly
// (64 KB every 40 ms), with or without a Content-Length.
/** @returns {Promise<{ url: string, close: () => void }>} */
function slowServer(dir, { length = true } = {}) {
  const server = http.createServer((req, res) => {
    const f = join(dir, req.url.slice(1));
    if (!isFile(f)) return res.writeHead(404).end(); // (also a local port scanner's "/")
    const body = readFileSync(f);
    res.writeHead(200, length ? { "content-length": body.length } : {});
    let at = 0;
    const next = () => {
      if (at >= body.length) return res.end();
      res.write(body.subarray(at, (at += 65536)));
      setTimeout(next, 40);
    };
    next();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
/** Runs a command without blocking this process (the server above lives in it). */
function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const t0 = Date.now();
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}
const TTY = process.platform === "linux" && existsSync("/usr/bin/script");
const inTerminal = (env) => run("script", ["-qec", `sh ${SH} --yes`, "/dev/null"], { TERM: "dumb", ...env });
const tarEnv = (d, tarball) => ({ PATH: "/usr/bin:/bin", HOME: d, DINOBOT_HOME: join(d, ".dinobot"), DINOBOT_NAME: "T", DINOBOT_TARBALL: tarball, DINOBOT_ALLOW_UNSIGNED: "1" });
const BAR = /Downloading {2}\[([#-]{20})\] +(\d+)% {2}(\d+)\/(\d+) MB/g;

describe("install.sh: download progress bar", () => {
  it("terminal: one line redrawn with \\r, the percentage rising, then 100% the moment it ends", { skip: !TTY }, async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 3 * 1048576 });
    const srv = await slowServer(d);
    try {
      const r = await inTerminal(tarEnv(d, `${srv.url}/${tar.split("/").pop()}`));
      assert.equal(r.code, 0, r.out + r.err);
      const bars = [...r.out.matchAll(BAR)];
      assert.ok(bars.length >= 3, r.out);
      const pcs = bars.map((m) => Number(m[2]));
      assert.ok(pcs.some((p) => p > 0 && p < 100), `a bar part-way: ${pcs}`);
      assert.deepEqual(pcs, [...pcs].sort((a, b) => a - b), "never goes back");
      const last = bars.at(-1);
      assert.equal(last[1], "#".repeat(20));
      assert.equal(last[2], "100");
      assert.equal(last[3], "3");
      assert.equal(last[4], "3");
      assert.match(r.out, /\rDownloading {2}\[#{20}\] 100% {2}3\/3 MB, done {3}\r?\n/);
      // Redrawn in place: every bar but the finished one is followed by \r, not a new line.
      assert.equal(r.out.split(/\r?\n/).filter((l) => l.includes("Downloading  [")).length, 1, r.out);
      assert.match(r.out, /Checking the download[\s\S]*WIZARD-STARTED/);
    } finally {
      srv.close();
    }
  });

  it("not a terminal (CI, logs): a few plain lines, no carriage returns", async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 3 * 1048576 });
    const srv = await slowServer(d);
    try {
      const r = await run("sh", [SH, "--yes"], tarEnv(d, `${srv.url}/${tar.split("/").pop()}`));
      assert.equal(r.code, 0, r.out + r.err);
      assert.doesNotMatch(r.out, /\r/);
      const lines = r.out.split("\n").filter((l) => /^Downloading( |$)/.test(l) && !/in the background/.test(l));
      assert.ok(lines.length >= 2 && lines.length <= 4, lines.join("\n"));
      assert.match(lines.at(-1), /^Downloading done \(3\/3 MB\)$/);
      for (const l of lines.slice(0, -1)) assert.match(l, /^Downloading {2}\d+\/3 MB \((25|50|75|[1-9]\d)%\)$/);
      assert.match(r.out, /WIZARD-STARTED/);
    } finally {
      srv.close();
    }
  });

  it("unknown size (no Content-Length): MB so far, no percentage, then done", { skip: !TTY }, async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 3 * 1048576 });
    const srv = await slowServer(d, { length: false });
    try {
      const r = await inTerminal(tarEnv(d, `${srv.url}/${tar.split("/").pop()}`));
      assert.equal(r.code, 0, r.out + r.err);
      const parts = r.out.split("\r").filter((l) => l.startsWith("Downloading  "));
      const running = parts.filter((l) => !/done/.test(l));
      assert.ok(running.length >= 2, r.out);
      for (const l of running) assert.match(l, /^Downloading {2}\d+ [KM]B {3}$/);
      // Once it has arrived the size is known: the finished bar.
      assert.match(r.out, /\rDownloading {2}\[#{20}\] 100% {2}3\/3 MB, done/);
    } finally {
      srv.close();
    }
  });

  it("finished before the name was answered: just the finished bar, once, at once", { skip: !TTY }, async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 2 * 1048576 });
    // The name's default comes from getent; a slow one means the (local) download is long done.
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "getent"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
    const r = await inTerminal({ ...tarEnv(d, tar), PATH: `${bin}:/usr/bin:/bin`, DINOBOT_NAME: "" });
    assert.equal(r.code, 0, r.out + r.err);
    const bars = [...r.out.matchAll(BAR)];
    assert.equal(bars.length, 1, r.out);
    assert.match(r.out, /\rDownloading {2}\[#{20}\] 100% {2}2\/2 MB, done/);
  });

  it("a failed download still shows download.log", async () => {
    const d = tmp();
    const srv = await slowServer(d);
    try {
      const r = await run("sh", [SH, "--yes"], tarEnv(d, `${srv.url}/missing.tar.gz`));
      assert.notEqual(r.code, 0);
      assert.match(r.out, /^Downloading failed$/m);
      assert.match(r.err, /404/);
      assert.match(r.err, /no release has been published yet|stopped: the network/);
    } finally {
      srv.close();
    }
  });
});

// Flaky networks (dbnet report: new connections stall, transfers stop dead): each try resumes the
// .part where the last stopped; a run that gives up keeps the .part and the next run resumes it.
/** A release server with byte ranges. cut(n, from): bytes to send on request n before dropping the connection (null: all). */
function rangeServer(dir, { cut = () => null } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const f = join(dir, req.url.slice(1));
    if (!isFile(f)) return res.writeHead(404).end();
    const body = readFileSync(f);
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const from = m ? Number(m[1]) : 0;
    log.push({ url: req.url, range: req.headers.range ?? null });
    if (from >= body.length) return res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
    const rest = body.subarray(from);
    res.writeHead(m ? 206 : 200, { "content-length": rest.length, "accept-ranges": "bytes", ...(m ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
    const n = cut(log.filter((l) => l.url === req.url).length, from);
    if (n == null) return res.end(rest);
    res.write(rest.subarray(0, n), () => res.socket.destroy());
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() })));
}

describe("install.sh: flaky network (resume, retry, rerun)", () => {
  const MB = 1048576;
  it("a connection dropped mid-download: the next try resumes from where it stopped (Range), installs", async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 2 * MB });
    const name = tar.split("/").pop();
    const srv = await rangeServer(d, { cut: (n) => (n === 1 ? MB : null) });
    try {
      const r = await run("sh", [SH, "--yes"], tarEnv(d, `${srv.url}/${name}`));
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /WIZARD-STARTED/);
      const tries = srv.log.filter((l) => l.url === `/${name}`);
      assert.equal(tries.length, 2, JSON.stringify(srv.log));
      assert.equal(tries[0].range, null);
      assert.match(tries[1].range, /^bytes=\d+-$/);
      assert.ok(Number(/=(\d+)/.exec(tries[1].range)[1]) >= MB / 2, tries[1].range);
      assert.match(readFileSync(join(d, ".dinobot", "logs", "download.log"), "utf8"), /trying again \(2\/6, resuming\)/);
    } finally {
      srv.close();
    }
  });

  it("gives up after 6 tries: says to run the same command again, keeps the .part; that run resumes it", async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 2 * MB });
    const name = tar.split("/").pop();
    let healthy = false;
    const srv = await rangeServer(d, { cut: () => (healthy ? null : 300_000) });
    try {
      const r = await run("sh", [SH, "--yes"], tarEnv(d, `${srv.url}/${name}`));
      const info = JSON.stringify(srv.log) + r.out + r.err;
      assert.notEqual(r.code, 0, info);
      assert.match(r.err, /Run the same install command again: it carries on where it stopped/, info);
      assert.equal(srv.log.filter((l) => l.url === `/${name}`).length, 6, info);
      const part = join(d, ".dinobot", "download", `${name}.part`);
      assert.ok(existsSync(part), "the .part is kept");
      assert.equal(existsSync(join(d, ".dinobot", "app")), false, "nothing installed");
      healthy = true;
      const before = srv.log.length;
      const again = await run("sh", [SH, "--yes"], tarEnv(d, `${srv.url}/${name}`));
      assert.equal(again.code, 0, again.out + again.err);
      assert.match(again.out, /WIZARD-STARTED/);
      const resumed = srv.log.slice(before).filter((l) => l.url === `/${name}`);
      assert.equal(resumed.length, 1, JSON.stringify(srv.log) + again.out + again.err);
      assert.match(resumed[0].range ?? "", /^bytes=[1-9]\d*-$/, "the rerun resumed");
    } finally {
      srv.close();
    }
  });

  it("a .part from an older release (checksum mismatch after resuming): downloaded again from 0, installs", async () => {
    const d = tmp();
    const tar = fakeRelease(d, { pad: 2 * MB });
    const name = tar.split("/").pop();
    mkdirSync(join(d, ".dinobot", "download"), { recursive: true });
    writeFileSync(join(d, ".dinobot", "download", `${name}.part`), randomBytes(MB));
    const srv = await rangeServer(d);
    try {
      const r = await run("sh", [SH, "--yes"], tarEnv(d, `${srv.url}/${name}`));
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /another release; downloading again from the start/);
      assert.match(r.out, /WIZARD-STARTED/);
      const tries = srv.log.filter((l) => l.url === `/${name}`);
      assert.deepEqual(tries.map((t) => t.range), [`bytes=${MB}-`, null]);
    } finally {
      srv.close();
    }
  });
});

describe("install.sh: the name is asked on the first install only", () => {
  it("over an existing install (state.json): no question, no --name (setup keeps the saved name)", { skip: process.platform !== "linux" || !existsSync("/usr/bin/script") }, () => {
    const d = tmp();
    const tar = fakeRelease(d);
    const stage = join(d, "stage", tar.split("/").pop().replace(/\.tar\.gz$/, ""));
    writeFileSync(join(stage, "node", "bin", "node"), '#!/bin/sh\necho "WIZARD-ARGS $*"\n');
    spawnSync("tar", ["-czf", tar, "-C", join(d, "stage"), stage.split("/").pop()]);
    writeFileSync(`${tar}.sha256`, `${createHash("sha256").update(readFileSync(tar)).digest("hex")}  x\n`);
    mkdirSync(join(d, ".dinobot"), { recursive: true });
    writeFileSync(join(d, ".dinobot", "state.json"), "{}");
    const env = { PATH: "/usr/bin:/bin", HOME: d, DINOBOT_HOME: join(d, ".dinobot"), DINOBOT_TARBALL: tar, DINOBOT_ALLOW_UNSIGNED: "1", TERM: "dumb" };
    const r = spawnSync("script", ["-qec", `sh ${SH}`, "/dev/null"], { env, input: "", encoding: "utf8", timeout: 60_000 });
    assert.doesNotMatch(r.stdout, /what should your bots call you/, r.stdout);
    assert.match(r.stdout, /WIZARD-ARGS .*cli\.mjs setup\s*$/m, r.stdout);
  });
});
