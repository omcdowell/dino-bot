// The pairing QR picture never outlives 10 minutes (SF3 addendum 1): each failure path and the
// layer that covers it, with short timers (DINOBOT_QR_TTL_MS).
// node --test test/qr-lifetime.test.mjs  (temp dirs under ./.test-tmp-qr-life, never /tmp)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { qrPictureCheck } from "../lib/doctor.mjs";
import { createOnboarding } from "../lib/phone-signin.mjs";
import { waitForPhone } from "../lib/phone-ready.mjs";
import { QR_PNG_TTL_MS, guardQrPng, qrPngPath, qrTtlMs, removeIfSameFile, startQrReaper, startQrSweep, sweepStaleQrPng, withQrGuard } from "../lib/qr.mjs";
import { layout, writeFileAtomic } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-qr-life");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const LIB = join(import.meta.dirname, "..", "lib");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig() {
  const h = mkdtempSync(join(TMP, "h-"));
  const L = layout({ HOME: h, DINOBOT_HOME: join(h, ".dinobot") });
  mkdirSync(L.root, { recursive: true });
  return { h, L, png: qrPngPath(L) };
}
const writePng = (path) => writeFileAtomic(path, "png with the password", 0o600);
const age = (path, ms) => {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
};
async function until(f, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await sleep(50);
  }
  return f();
}

/** A wizard stand-in in its own process: writes the picture (+ reaper), guards it, then waits. */
function wizard(L, { ttl = 1500, guard = true } = {}) {
  const code = `
    import { guardQrPng, qrPngPath, startQrReaper } from ${JSON.stringify(join(LIB, "qr.mjs"))};
    import { writeFileAtomic } from ${JSON.stringify(join(LIB, "util.mjs"))};
    const L = ${JSON.stringify(L)};
    writeFileAtomic(qrPngPath(L), "png", 0o600);
    startQrReaper(qrPngPath(L), { env: { DINOBOT_QR_TTL_MS: "${ttl}" }, pollMs: 100 });
    ${guard ? "guardQrPng(L);" : ""}
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((r) => child.stdout.on("data", (d) => String(d).includes("ready") && r()));
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return { child, ready, exited };
}

describe("pairing picture lifetime (addendum 1)", () => {
  it("10 minutes; the env can only shorten it", () => {
    assert.equal(QR_PNG_TTL_MS, 600_000);
    assert.equal(qrTtlMs({}), 600_000);
    assert.equal(qrTtlMs({ DINOBOT_QR_TTL_MS: "2000" }), 2000);
    assert.equal(qrTtlMs({ DINOBOT_QR_TTL_MS: "99999999" }), 600_000);
  });

  // Layer 1: the wizard.
  for (const [sig, exit] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    it(`${sig} (Ctrl-C / kill / terminal closed): the wizard removes it and exits ${exit}`, async () => {
      const { L, png } = rig();
      const w = wizard(L, { ttl: 60_000 });
      await w.ready;
      assert.ok(existsSync(png));
      w.child.kill(sig);
      const r = await w.exited;
      assert.equal(r.code, exit);
      assert.ok(!existsSync(png));
    });
  }

  it("a throw in setup removes it (withQrGuard); a normal end leaves it to the reaper", async () => {
    const { L, png } = rig();
    writePng(png);
    await assert.rejects(withQrGuard(L, async () => { throw new Error("daemon never became ready"); }), /never became ready/);
    assert.ok(!existsSync(png));
    writePng(png);
    assert.equal(await withQrGuard(L, async () => "done"), "done");
    assert.ok(existsSync(png));
    assert.equal(process.listenerCount("SIGHUP"), 0); // the guard is released
  });

  it("guardQrPng in-process: the handler removes and exits with the signal's code", () => {
    const { L, png } = rig();
    writePng(png);
    const handlers = {};
    const exits = [];
    const release = guardQrPng(L, { proc: { on: (s, h) => (handlers[s] = h), removeListener: (s) => delete handlers[s] }, exit: (c) => exits.push(c) });
    assert.deepEqual(Object.keys(handlers).sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
    handlers.SIGHUP();
    assert.ok(!existsSync(png));
    assert.deepEqual(exits, [129]);
    release();
    assert.deepEqual(Object.keys(handlers), []);
  });

  it("the wait's timeout and a throw inside the wait remove it", async () => {
    const { L, png } = rig();
    writePng(png);
    let t = 0;
    const deps = { say: () => {}, now: () => t, sleep: async (ms) => void (t += ms), readyProviders: async () => [], claudeLoggedIn: async () => false };
    assert.equal(await waitForPhone(L, 10_000, deps), "timeout");
    assert.ok(!existsSync(png));
    writePng(png);
    await assert.rejects(waitForPhone(L, 10_000, { ...deps, sleep: async () => { throw new Error("boom"); } }), /boom/);
    assert.ok(!existsSync(png));
  });

  // Layer 2: the detached reaper.
  it("wizard killed with SIGKILL (no handler runs): the detached reaper removes it at the deadline", async () => {
    const { L, png } = rig();
    const w = wizard(L, { ttl: 1500 });
    await w.ready;
    w.child.kill("SIGKILL");
    await w.exited;
    assert.ok(existsSync(png), "still there right after the kill");
    assert.ok(await until(() => !existsSync(png), 6000), "the reaper removed it");
  });

  it("the reaper never removes a newer QR (replaced file: other inode/mtime)", async () => {
    const { png } = rig();
    writePng(png);
    startQrReaper(png, { env: { DINOBOT_QR_TTL_MS: "600" }, pollMs: 50 });
    await sleep(100);
    rmSync(png);
    writePng(png); // a new run's picture (its own reaper would handle it)
    await sleep(1200);
    assert.ok(existsSync(png));
  });

  it("a Mac that slept past the deadline: the reaper removes it at once on wake (wall clock)", async () => {
    const { png } = rig();
    writePng(png);
    age(png, 20 * 60_000);
    startQrReaper(png, { env: {}, pollMs: 50 });
    assert.ok(await until(() => !existsSync(png), 4000));
  });

  it("removeIfSameFile checks inode and mtime", () => {
    const { png } = rig();
    writePng(png);
    const st = statSync(png);
    assert.equal(removeIfSameFile(png, st.ino, Math.floor(st.mtimeMs) + 5), false);
    assert.equal(removeIfSameFile(png, st.ino, Math.floor(st.mtimeMs)), true);
    assert.equal(removeIfSameFile(png, st.ino, Math.floor(st.mtimeMs)), false);
  });

  it("DINOBOT_QR_REAPER=0 starts no reaper (tests that write pictures)", () => {
    const { png } = rig();
    writePng(png);
    assert.equal(startQrReaper(png, { env: { DINOBOT_QR_REAPER: "0" } }), null);
  });

  // Layer 3: the daemon after a reboot, and doctor.
  it("reboot (no wizard, no reaper): the daemon's sweep at start removes one older than 10 min, keeps a fresh one", () => {
    const { h, L, png } = rig();
    writePng(png);
    age(png, 11 * 60_000);
    const ob = createOnboarding({ HOME: h, DINOBOT_HOME: L.root, PATH: "/usr/bin:/bin" });
    ob.stopQrSweep();
    assert.ok(!existsSync(png));
    writePng(png);
    const ob2 = createOnboarding({ HOME: h, DINOBOT_HOME: L.root, PATH: "/usr/bin:/bin" });
    ob2.stopQrSweep();
    assert.ok(existsSync(png));
  });

  it("the daemon's periodic sweep removes it once it turns 10 min old", async () => {
    const { L, png } = rig();
    writePng(png);
    const stop = startQrSweep(L, { env: { DINOBOT_QR_TTL_MS: "400" }, intervalMs: 50 });
    assert.ok(existsSync(png));
    assert.ok(await until(() => !existsSync(png), 3000));
    stop();
  });

  it("sweepStaleQrPng: none, fresh, stale", () => {
    const { L, png } = rig();
    assert.deepEqual(sweepStaleQrPng(L), { removed: false, present: false, ageMs: null });
    writePng(png);
    assert.equal(sweepStaleQrPng(L).present, true);
    assert.equal(sweepStaleQrPng(L, { now: Date.now() + 10 * 60_000 + 1000 }).removed, true);
    assert.ok(!existsSync(png));
  });

  it("doctor reports and removes a stale one; a fresh one is OK with its time left", () => {
    const { L, png } = rig();
    assert.equal(qrPictureCheck(L), null);
    writePng(png);
    const fresh = qrPictureCheck(L);
    assert.equal(fresh.status, "ok");
    assert.match(fresh.detail, /removed automatically in 10 min/);
    age(png, 30 * 60_000);
    const stale = qrPictureCheck(L);
    assert.equal(stale.status, "WARN");
    assert.match(stale.detail, /removed a pairing picture left for 30 min/);
    assert.ok(!existsSync(png));
  });

  it("writing the picture starts its reaper (writeQrPng)", async () => {
    const { L, png } = rig();
    const { writeQrPng } = await import("../lib/qr.mjs");
    const reaped = [];
    await writeQrPng({ toBuffer: async () => Buffer.from("png") }, L, "dinobot://pair/#offer=x", { reap: (p) => reaped.push(p) });
    assert.deepEqual(reaped, [png]);
  });
});

