// H-W9: the terminal's wait after the QR (lib/phone-ready.mjs). A Claude-Code-only user gets
// "Signed in" and "Your bots are ready", and the QR picture (it holds the pairing password) goes on
// success, on the timeout and on Ctrl-C.
// node --test test/phone-ready.test.mjs  (temp dirs under ./.test-tmp-phone-ready, never /tmp)
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createOnboarding } from "../lib/phone-signin.mjs";
import { clearPhoneSteps, daemonClaudeEnv, markPhoneStep, phoneProgress, phoneStepsPath, readPhoneSteps, waitForPhone } from "../lib/phone-ready.mjs";
import { qrPngPath } from "../lib/qr.mjs";
import { layout } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-phone-ready");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

function rig() {
  const h = mkdtempSync(join(TMP, "h-"));
  const L = layout({ HOME: h, DINOBOT_HOME: join(h, ".dinobot") });
  mkdirSync(L.root, { recursive: true });
  writeFileSync(qrPngPath(L), "png with the password");
  writeFileSync(L.state, JSON.stringify({ version: 1 }));
  return { h, L };
}

/** A clock that moves on with each sleep, and the lines said. */
function harness(L, { onSleep = () => {}, ...rest } = {}) {
  let t = 0;
  const lines = [];
  return {
    lines,
    deps: {
      say: (s) => lines.push(s),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        onSleep(t);
      },
      pollMs: 2000,
      ...rest,
    },
  };
}

describe("phone-ready (H-W9)", () => {
  it("Claude-Code-only: signed in once the phone is on the sign-in step, ready at the models step; QR gone", async () => {
    const { L } = rig();
    const { lines, deps } = harness(L, {
      readyProviders: async () => [],
      claudeLoggedIn: async () => true, // already logged in before the phone came (the user's own ~/.claude)
      onSleep: (t) => {
        if (t === 4000) markPhoneStep(L, "signin");
        if (t === 8000) markPhoneStep(L, "models"); // "Continue with this" -> Choose models (nothing to pick)
      },
    });
    const r = await waitForPhone(L, 60_000, deps);
    assert.equal(r, "ready");
    assert.ok(!existsSync(qrPngPath(L)));
    const text = lines.join("\n");
    assert.match(text, /✓ Signed in from the app \(Claude Code; checked with claude auth status\)\./);
    assert.match(text, /bots +on Claude Code/);
    assert.match(text, /Your bots are ready\./);
    // Not before the phone came: the first two looks said nothing.
    assert.equal(lines.filter((l) => l.startsWith("✓ Signed in")).length, 1);
  });

  it("a Claude Code login on the computer alone (no phone yet) is not 'signed in from the app': QR kept", async () => {
    const { L } = rig();
    let asked = 0;
    const p = await phoneProgress(L, { readyProviders: async () => [], claudeLoggedIn: async () => (asked++, true) });
    assert.deepEqual([p.signedIn, p.ready, asked], [[], false, 0]);
    assert.ok(existsSync(qrPngPath(L)));
  });

  it("Claude Code logged in but not at the models step yet: signed in, not ready", async () => {
    const { L } = rig();
    markPhoneStep(L, "signin");
    const p = await phoneProgress(L, { readyProviders: async () => [], claudeLoggedIn: async () => true });
    assert.deepEqual([p.signedIn, p.ready], [["Claude Code"], false]);
  });

  it("pi and Claude Code: ready only when models are saved (the pi user still chooses models)", async () => {
    const { L } = rig();
    markPhoneStep(L, "signin");
    markPhoneStep(L, "models");
    const deps = { readyProviders: async () => ["anthropic"], claudeLoggedIn: async () => true };
    let p = await phoneProgress(L, deps);
    assert.deepEqual([p.signedIn, p.ready], [["anthropic", "Claude Code"], false]);
    writeFileSync(L.state, JSON.stringify({ models: { bots: { provider: "anthropic", model: "claude-opus-5-5", thinking: "medium" } } }));
    p = await phoneProgress(L, deps);
    assert.equal(p.ready, true);
  });

  it("pi only, as before: signed in from pi auth check (no phone step needed), ready with models; Claude Code not asked", async () => {
    const { L } = rig();
    let asked = 0;
    const { lines, deps } = harness(L, {
      readyProviders: async () => ["openrouter"],
      claudeLoggedIn: async () => (asked++, false),
      onSleep: (t) => {
        if (t === 2000) writeFileSync(L.state, JSON.stringify({ models: { bots: { provider: "openrouter", model: "x", thinking: null } } }));
      },
    });
    assert.equal(await waitForPhone(L, 60_000, deps), "ready");
    assert.equal(asked, 0);
    assert.ok(!existsSync(qrPngPath(L)));
    assert.match(lines.join("\n"), /Signed in from the app \(openrouter; checked with pi auth check\)[\s\S]*✓ bots +openrouter\/x[\s\S]*ready/);
  });

  it("timeout: the QR picture goes too, and the way to show it again is said", async () => {
    const { L } = rig();
    const { lines, deps } = harness(L, { readyProviders: async () => [], claudeLoggedIn: async () => false, pairCommand: "dinobot pair" });
    assert.equal(await waitForPhone(L, 10 * 60_000, deps), "timeout");
    assert.ok(!existsSync(qrPngPath(L)));
    assert.match(lines.at(-1), /Still waiting for the phone.*dinobot pair/);
  });

  it("a failing check is 'not yet', never a crash", async () => {
    const { L } = rig();
    markPhoneStep(L, "models");
    const p = await phoneProgress(L, { readyProviders: async () => Promise.reject(new Error("pi gone")), claudeLoggedIn: async () => Promise.reject(new Error("claude gone")) });
    assert.deepEqual([p.signedIn, p.ready], [[], false]);
  });

  it("markPhoneStep keeps the first time, clearPhoneSteps forgets (a new QR)", () => {
    const { L } = rig();
    markPhoneStep(L, "signin");
    const first = readPhoneSteps(L).signin;
    markPhoneStep(L, "signin");
    assert.equal(readPhoneSteps(L).signin, first);
    clearPhoneSteps(L);
    assert.ok(!existsSync(phoneStepsPath(L)));
    assert.deepEqual(readPhoneSteps(L), {});
  });

  it("the daemon's Claude config dir and binary, as doctor uses them", () => {
    const { L } = rig();
    writeFileSync(L.envFile, "DINOBOT_CLAUDE_CONFIG_DIR=/x/ccfg\nPASEO_PASSWORD=p\n");
    const env = daemonClaudeEnv(L, { HOME: "/h", DINOBOT_CLAUDE_BIN: "/mine" });
    assert.equal(env.DINOBOT_CLAUDE_CONFIG_DIR, "/x/ccfg");
    assert.equal(env.DINOBOT_CLAUDE_BIN, "/mine");
    assert.equal(env.PASEO_PASSWORD, undefined);
  });

  it("the host notes the phone's steps: signin.options -> signin, setup.models -> models", async () => {
    const { h, L } = rig();
    mkdirSync(L.bin, { recursive: true });
    writeFileSync(join(L.bin, "pi"), `#!/bin/sh
if [ "$1" = --mode ]; then cat >/dev/null & echo '{"id":"models","type":"response","command":"get_available_models","success":true,"data":{"models":[]}}'; wait; fi
exit 0
`);
    chmodSync(join(L.bin, "pi"), 0o755);
    const ob = createOnboarding({ HOME: h, DINOBOT_HOME: L.root, PATH: "/usr/bin:/bin" });
    await Promise.resolve(ob.options()).catch(() => null);
    assert.ok(readPhoneSteps(L).signin);
    assert.equal(readPhoneSteps(L).models, undefined);
    await Promise.resolve(ob.models({})).catch(() => null); // pi lists nothing here; the step is noted anyway
    assert.ok(readPhoneSteps(L).models);
  });
});
