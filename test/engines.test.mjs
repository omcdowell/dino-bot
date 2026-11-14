// Settings › Providers, "Two engines" (bots plugin engines.* RPCs -> lib/engines.mjs).
// node --test test/engines.test.mjs  (temp dirs under ./.test-tmp-engines, never /tmp)
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  CLAUDE_CODE_OPTION_ID,
  claudeCodeBots,
  claudeCodeLogout,
  claudeCodeStatus,
  keyHint,
  parseClaudeVersion,
  piCard,
  readClaudeAuth,
  removePiCredential,
  versionAtLeast,
} from "../lib/engines.mjs";
import { createOnboarding, PhoneSignIn } from "../lib/phone-signin.mjs";
import { layout } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-engines");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

const OR_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef4f2a";
const ANT_KEY = "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ91c0";

/** A DinoBot home whose bin/pi says every provider is ready, with pi's auth.json. */
function home(auth = {}) {
  const h = mkdtempSync(join(TMP, "h-"));
  const L = layout({ HOME: h, DINOBOT_HOME: join(h, ".dinobot") });
  mkdirSync(L.bin, { recursive: true });
  writeFileSync(
    join(L.bin, "pi"),
    `#!/bin/sh
if [ "$1" = auth ]; then echo '{"status":"ready","provider":"'"$4"'"}'; exit 0; fi
exit 0
`,
  );
  chmodSync(join(L.bin, "pi"), 0o755);
  mkdirSync(L.piAgentDir, { recursive: true });
  writeFileSync(join(L.piAgentDir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return { h, L };
}

/**
 * A fake `claude`: --version; auth status --json (logged in when $STATE/in exists);
 * auth login (prints the link and waits for a code on stdin: "good" logs in); auth logout.
 */
function fakeClaude(h, { plan = "max" } = {}) {
  const state = join(h, "claude-state");
  mkdirSync(state, { recursive: true });
  const bin = join(h, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
S="${state}"
echo "$CLAUDE_CONFIG_DIR|$BROWSER|$*" >> "$S/calls"
case "$1 $2" in
  "--version ") echo "2.1.323 (Claude Code)";;
  "auth status")
    if [ -f "$S/in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"me@example.com","subscriptionType":"${plan}"}'; exit 0; fi
    echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1;;
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = good ]; then touch "$S/in"; echo "Login successful."; exit 0; fi
    echo "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt."; exit 1;;
  "auth logout") rm -f "$S/in"; echo "Successfully logged out from your Anthropic account.";;
  *) exit 2;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, state };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("pi card", () => {
  it("shows an API key only as its public prefix and last 4 characters", () => {
    assert.equal(keyHint(OR_KEY), "sk-or-…4f2a");
    assert.equal(keyHint(ANT_KEY), "sk-ant-…91c0");
    assert.equal(keyHint("AIzaSyD-0123456789abcdefXYZW"), "…XYZW");
    assert.equal(keyHint("short-key"), "••••");
    assert.equal(keyHint("OPENROUTER_API_KEY"), "$OPENROUTER_API_KEY");
    assert.equal(keyHint("!op read op://x/y"), "from a command");
    assert.equal(keyHint(""), null);
  });

  it("decorates the provider rows with the kind of sign-in and a key hint, never the key", () => {
    const list = {
      packages: [{ source: "npm:pi-web-access", bundled: true }],
      providers: [
        { provider: "openai-codex", plugin: null, ready: true, optionId: "openai-codex:device-code:0", label: "ChatGPT (Codex)" },
        { provider: "openrouter", plugin: null, ready: true, optionId: "openrouter:api-key:2", label: "OpenRouter" },
        { provider: "acme", plugin: "Acme", ready: false, optionId: null, label: "acme" },
      ],
    };
    const auth = { "openai-codex": { type: "oauth", access: "SECRET-ACCESS", refresh: "SECRET-REFRESH" }, openrouter: { type: "api_key", key: OR_KEY } };
    const card = piCard(list, auth);
    assert.equal(card.ready, true);
    assert.equal(card.readyCount, 2);
    assert.equal(card.isDefault, true);
    assert.deepEqual(
      card.signins.map((s) => [s.provider, s.kind, s.keyHint, s.canSignOut]),
      [
        ["openai-codex", "login", null, true],
        ["openrouter", "key", "sk-or-…4f2a", true],
        ["acme", null, null, false],
      ],
    );
    const text = JSON.stringify(card);
    for (const secret of [OR_KEY, "SECRET-ACCESS", "SECRET-REFRESH"]) assert.ok(!text.includes(secret));
    assert.equal(piCard({ providers: [] }, {}).ready, false);
  });

  it("signs out of one provider: its entry leaves auth.json, the rest stays, the file stays 0600", () => {
    const { L } = home({ openrouter: { type: "api_key", key: OR_KEY }, "openai-codex": { type: "oauth", access: "a" } });
    assert.deepEqual(removePiCredential(L, "openrouter"), { removed: "openrouter" });
    const path = join(L.piAgentDir, "auth.json");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["openai-codex"]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => removePiCredential(L, "openrouter"), /not signed in/);
    assert.throws(() => removePiCredential(L, "../x"), /not a provider/);
    assert.throws(() => removePiCredential(L, "__proto__x/"), /not a provider/);
  });

  it("end to end through createOnboarding: status shows the sign-ins, sign out removes one", async () => {
    const { h, L } = home({ openrouter: { type: "api_key", key: OR_KEY }, "openai-codex": { type: "oauth", access: "a", refresh: "b", expires: 1 } });
    const ob = createOnboarding({ HOME: h, DINOBOT_HOME: L.root, PATH: "/usr/bin:/bin", DINOBOT_CLAUDE_BIN: join(h, "no-claude") });
    const before = await ob.enginesStatus();
    assert.deepEqual(before.pi.signins.map((s) => [s.provider, s.ready, s.kind, s.keyHint]).sort(), [
      ["openai-codex", true, "login", null],
      ["openrouter", true, "key", "sk-or-…4f2a"],
    ]);
    assert.ok(!JSON.stringify(before).includes(OR_KEY));
    assert.deepEqual(before.claudeCode.installed, false);
    assert.deepEqual(ob.piSignOut({ provider: "openrouter" }), { removed: "openrouter" });
    const afterOut = await ob.enginesStatus();
    assert.deepEqual(afterOut.pi.signins.map((s) => s.provider), ["openai-codex"]);
  });
});

describe("Claude Code card", () => {
  it("reads versions and plans", () => {
    assert.equal(parseClaudeVersion("2.1.323 (Claude Code)\n"), "2.1.323");
    assert.equal(parseClaudeVersion("nope"), null);
    assert.ok(versionAtLeast("2.1.323", "2.1.287"));
    assert.ok(versionAtLeast("2.1.287", "2.1.287"));
    assert.ok(!versionAtLeast("2.1.99", "2.1.287"));
    assert.ok(versionAtLeast("3.0.0", "2.1.287"));
    assert.deepEqual(readClaudeAuth({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }), { loggedIn: true, authMethod: "claude.ai", plan: "Max plan", warning: null });
    assert.equal(readClaudeAuth({ loggedIn: true, authMethod: "api_key" }).plan, "API key");
    assert.match(readClaudeAuth({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" }).warning, /Team and Enterprise/);
    assert.deepEqual(readClaudeAuth({ loggedIn: false, authMethod: "none" }), { loggedIn: false, authMethod: "none", plan: null, warning: null });
  });

  it("not installed: says so, no error", async () => {
    const h = mkdtempSync(join(TMP, "cc-"));
    const st = await claudeCodeStatus({ HOME: h, PATH: "", DINOBOT_CLAUDE_BIN: join(h, "missing") });
    assert.equal(st.installed, false);
    assert.equal(st.error, null);
  });

  it("lists the bots whose CC-OptChat host is running (registry, live pid only)", () => {
    const h = mkdtempSync(join(TMP, "cc-"));
    const dir = join(h, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cc-tweety.json"), JSON.stringify({ id: "cc-tweety", bot: "tweety", hostPid: process.pid }));
    writeFileSync(join(dir, "cc-gone.json"), JSON.stringify({ id: "cc-gone", bot: "gone", hostPid: 2 ** 22 + 12345 }));
    writeFileSync(join(dir, "other.json"), JSON.stringify({ bot: "nope" }));
    assert.deepEqual(claudeCodeBots({ CC_OPTCHAT_AGENTS: dir }), ["tweety"]);
    assert.deepEqual(claudeCodeBots({ HOME: h }), []);
  });

  it("login from the phone end to end: the link, the pasted code to claude's stdin, then logged in; logout", async () => {
    const { h, L } = home({});
    const cc = fakeClaude(h);
    const env = { HOME: h, DINOBOT_HOME: L.root, PATH: "/usr/bin:/bin", DINOBOT_CLAUDE_BIN: cc.bin, DINOBOT_CLAUDE_CONFIG_DIR: join(h, "ccfg") };
    assert.equal((await claudeCodeStatus(env)).loggedIn, false);
    const signin = new PhoneSignIn(L, env, { overrides: () => [] });

    // A wrong code: the error claude gives, no login.
    let s = await signin.start({ optionId: CLAUDE_CODE_OPTION_ID });
    assert.equal(s.provider, "claude-code");
    s = await until(() => {
      const x = signin.status({ sessionId: s.sessionId });
      return x.state === "needs-input" && x;
    });
    assert.match(s.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    assert.equal(s.prompt.kind, "code");
    signin.submit({ sessionId: s.sessionId, text: "bad" });
    s = await until(() => {
      const x = signin.status({ sessionId: s.sessionId });
      return x.state === "error" && x;
    });
    assert.match(s.error, /code wasn't accepted/);
    assert.ok(!s.error.includes("oauth/authorize"));

    // The right code.
    s = await signin.start({ optionId: CLAUDE_CODE_OPTION_ID });
    await until(() => signin.status({ sessionId: s.sessionId }).state === "needs-input");
    assert.throws(() => signin.submit({ sessionId: s.sessionId, text: "  " }), /Paste the code/);
    signin.submit({ sessionId: s.sessionId, text: " good \n" });
    await until(() => signin.status({ sessionId: s.sessionId }).state === "done");

    const st = await claudeCodeStatus(env);
    assert.deepEqual([st.installed, st.version, st.modsReady, st.loggedIn, st.plan], [true, "2.1.323", true, true, "Max plan"]);
    assert.ok(!JSON.stringify(st).includes("me@example.com")); // the card needs no email
    // claude ran with DinoBot's Claude config dir, and no browser on the computer.
    const calls = readFileSync(join(cc.state, "calls"), "utf8");
    assert.match(calls, new RegExp(`${join(h, "ccfg")}\\|true\\|auth login --claudeai`));

    assert.deepEqual(await claudeCodeLogout(env), { ok: true });
    assert.equal((await claudeCodeStatus(env)).loggedIn, false);
    assert.ok(!existsSync(join(cc.state, "in")));
  });

  it("cancel stops a login waiting for its code", async () => {
    const { h, L } = home({});
    const cc = fakeClaude(h);
    const env = { HOME: h, PATH: "/usr/bin:/bin", DINOBOT_CLAUDE_BIN: cc.bin };
    const signin = new PhoneSignIn(L, env, { overrides: () => [] });
    const s = await signin.start({ optionId: CLAUDE_CODE_OPTION_ID });
    await until(() => signin.status({ sessionId: s.sessionId }).state === "needs-input");
    assert.deepEqual(signin.cancel({ sessionId: s.sessionId }), { ok: true });
    assert.throws(() => signin.status({ sessionId: s.sessionId }), /Unknown sign-in/);
  });

  it("not installed: the login says what to do", async () => {
    const { h, L } = home({});
    const signin = new PhoneSignIn(L, { HOME: h, PATH: "", DINOBOT_CLAUDE_BIN: join(h, "missing") }, { overrides: () => [] });
    await assert.rejects(signin.start({ optionId: CLAUDE_CODE_OPTION_ID }), /not installed/);
  });
});
