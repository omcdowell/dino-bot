import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliDist, loadCliInternals } from "../bot-dm/paseo.ts";

/** A fake @getpaseo/cli dist with the two modules bot-dm/bot-room import. */
function fakeDist(dir: string) {
  mkdirSync(join(dir, "utils"), { recursive: true });
  writeFileSync(join(dir, "utils", "client.js"), "export async function connectToDaemon() { return {}; }\n");
  writeFileSync(join(dir, "utils", "daemon-target.js"), "export function selectDaemonTarget() { return {}; }\n");
  return dir;
}

test("cliDist: PASEO_CLI_DIST wins over everything", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bf-dist-"));
  try {
    fakeDist(join(tmp, "app", "daemon", "dist"));
    assert.equal(cliDist({ PASEO_CLI_DIST: "/x/dist", HOME: tmp }, join(tmp, "app", "bots")), "/x/dist");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cliDist: a DinoBot install finds the bundled daemon next to the bots plugin, no env needed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bf-dist-"));
  try {
    const dist = fakeDist(join(tmp, ".dinobot", "app", "daemon", "dist"));
    const got = cliDist({ HOME: join(tmp, "home") }, join(tmp, ".dinobot", "app", "bots"));
    assert.equal(got, dist);
    const internals = await loadCliInternals(got);
    assert.equal(typeof internals.connectToDaemon, "function");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cliDist: DINOBOT_HOME's app/daemon/dist when the plugin runs from elsewhere", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bf-dist-"));
  try {
    const dist = fakeDist(join(tmp, "dino", "app", "daemon", "dist"));
    assert.equal(cliDist({ HOME: tmp, DINOBOT_HOME: join(tmp, "dino") }, join(tmp, "checkout", "paseo-bots")), dist);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cliDist: dev host (no bundled daemon) keeps the global npm path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bf-dist-"));
  try {
    // An empty DinoBot dir (no utils/client.js) does not count.
    mkdirSync(join(tmp, "dino", "app", "daemon", "dist"), { recursive: true });
    assert.equal(
      cliDist({ HOME: tmp, DINOBOT_HOME: join(tmp, "dino") }, join(tmp, "checkout", "paseo-bots")),
      join(tmp, ".local/lib/node_modules/@getpaseo/cli/dist"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
