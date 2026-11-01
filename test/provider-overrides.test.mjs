// A provider plugin that replaces pi's "anthropic" provider changes the Claude login's wording
// (EXTRA USAGE -> "your plan, via <plugin>", unofficial). Detected generically from pi itself.
// node --test test/provider-overrides.test.mjs  (temp dirs under ./.test-tmp-povr, never /tmp)
// The probe test against a real pi runs when pi is found: DINOBOT_TEST_PI_DIR, else
// .cache/pi-<PI_VERSION>/lib/node_modules/@earendil-works/pi-coding-agent (build-tarball.sh's cache).
// DINOBOT_TEST_BOTS_DIR (a paseo-bots checkout) also checks the wording from shared/sign-in.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { humanizeName, pluginName, providerOverrides } from "../lib/provider-overrides.mjs";
import { PhoneSignIn, signedInLabels } from "../lib/phone-signin.mjs";
import { defaultOption, signInOptions } from "../lib/signin.mjs";

const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".test-tmp-povr");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const tmp = () => mkdtempSync(join(TMP, "h-"));

function fakeLayout() {
  const root = tmp();
  const L = { home: root, root, app: join(root, "app"), node: join(root, "app", "node", "bin", "node"), piAgentDir: join(root, "pi") };
  mkdirSync(L.app, { recursive: true });
  mkdirSync(L.piAgentDir, { recursive: true });
  return L;
}

function writePlugin(dir, name, body) {
  mkdirSync(join(dir, "extensions"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", keywords: ["pi-package"], pi: { extensions: ["./extensions/index.ts"] } }));
  writeFileSync(join(dir, "extensions", "index.ts"), body);
}

describe("plugin names", () => {
  it("humanizes package names, prefers a display name", () => {
    assert.equal(humanizeName("acme-claude_bridge"), "Acme Claude Bridge");
    assert.equal(humanizeName("@scope/pi-thing"), "Pi Thing");
    const L = fakeLayout();
    const dir = join(L.root, "p");
    writePlugin(dir, "acme-bridge", "");
    assert.equal(pluginName(dir), "Acme Bridge");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme-bridge", displayName: "ACME Bridge" }));
    assert.equal(pluginName(dir), "ACME Bridge");
    assert.equal(pluginName(null, join(L.root, "nowhere", "ext.ts")), "Nowhere");
  });
});

describe("providerOverrides (probe faked)", () => {
  it("names the plugin per provider, caches until pi's settings change, [] without settings", async () => {
    const L = fakeLayout();
    let calls = 0;
    const pluginDir = join(L.root, "plug");
    writePlugin(pluginDir, "acme-claude", "");
    const probe = async () => {
      calls++;
      return { registrations: [{ provider: "anthropic", extensionPath: join(pluginDir, "extensions", "index.ts"), baseDir: pluginDir }], errors: [] };
    };
    assert.deepEqual(await providerOverrides(L, { probe }), []);
    assert.equal(calls, 0, "no settings.json: nothing added, pi not started");
    const settings = join(L.piAgentDir, "settings.json");
    writeFileSync(settings, JSON.stringify({ packages: [pluginDir] }));
    const first = await providerOverrides(L, { probe });
    assert.deepEqual(first.map((o) => [o.provider, o.plugin]), [["anthropic", "Acme Claude"]]);
    await providerOverrides(L, { probe });
    assert.equal(calls, 1, "cached");
    utimesSync(settings, new Date(), new Date(Date.now() + 5000));
    await providerOverrides(L, { probe });
    assert.equal(calls, 2, "settings changed: asked again");
  });
  it("a timed-out probe is not cached (asked again next time); a good answer is saved for the bots plugin's process", async () => {
    const L = fakeLayout();
    const pluginDir = join(L.root, "plug");
    writePlugin(pluginDir, "acme-claude", "");
    writeFileSync(join(L.piAgentDir, "settings.json"), JSON.stringify({ packages: [pluginDir] }));
    let calls = 0;
    const slow = async () => (calls++, { registrations: [], errors: ["provider probe timed out"] });
    assert.deepEqual(await providerOverrides(L, { probe: slow }), []);
    assert.deepEqual(await providerOverrides(L, { probe: slow }), []);
    assert.equal(calls, 2, "a failure is never cached");
    assert.equal(existsSync(join(L.root, "state", "provider-overrides.json")), false);
    const good = async () => ({ registrations: [{ provider: "anthropic", extensionPath: join(pluginDir, "extensions", "index.ts"), baseDir: pluginDir }], errors: [] });
    assert.equal((await providerOverrides(L, { probe: good, fresh: true }))[0].plugin, "Acme Claude");
    const saved = JSON.parse(readFileSync(join(L.root, "state", "provider-overrides.json"), "utf8"));
    assert.equal(saved.result[0].plugin, "Acme Claude");
    // Another process (the bots plugin) with the same settings: answered from the file, pi not started.
    const L2 = { ...L, piAgentDir: L.piAgentDir };
    const other = await import(`../lib/provider-overrides.mjs?other=${Date.now()}`);
    const never = async () => assert.fail("probe must not run: the saved answer matches pi's settings");
    assert.equal((await other.providerOverrides(L2, { probe: never }))[0].plugin, "Acme Claude");
  });
  it("a failing probe means no override (plain wording)", async () => {
    const L = fakeLayout();
    writeFileSync(join(L.piAgentDir, "settings.json"), "{}");
    assert.deepEqual(await providerOverrides(L, { probe: async () => ({ registrations: [], errors: ["boom"] }) }), []);
  });
});

describe("sign-in list wording", () => {
  it("EXTRA USAGE by default; 'your plan, via <plugin>' when a plugin replaces anthropic; same ids", async () => {
    const L = fakeLayout(); // no bundled bots plugin: the installer's fallback copy of the wording
    const plain = await signInOptions(L.app, {});
    const via = await signInOptions(L.app, {}, { overrides: [{ provider: "anthropic", plugin: "Acme Bridge" }] });
    assert.deepEqual(via.map((o) => o.id), plain.map((o) => o.id));
    const c0 = plain.find((o) => o.provider === "anthropic" && o.method === "paste-code");
    const c1 = via.find((o) => o.provider === "anthropic" && o.method === "paste-code");
    assert.equal(c0.badge, "EXTRA USAGE");
    assert.equal(c1.badge, "UNOFFICIAL");
    assert.equal(c1.label, "Claude login (your plan, via Acme Bridge)");
    assert.equal(c1.note, "Uses your Claude plan through Acme Bridge (unofficial; Anthropic's terms risk).");
    assert.match(c1.confirm.body, /included usage, not extra usage/);
    assert.equal(c1.confirm.ok, "Continue with Claude");
    // The API-key row and the other providers are untouched; a plugin for another provider changes nothing.
    assert.deepEqual(via.find((o) => o.label === "Anthropic API key"), plain.find((o) => o.label === "Anthropic API key"));
    const other = await signInOptions(L.app, {}, { overrides: [{ provider: "acme-local", plugin: "Acme Local" }] });
    assert.deepEqual(other, plain);
    // Still listed last and never pre-selected.
    assert.equal(via.at(-1).id, c1.id);
    assert.notEqual(defaultOption(via, { codexCli: false, userOauth: ["anthropic"] }).id, c1.id);
  });

  it("the phone list uses the host's plugins and still needs the confirm", async () => {
    const L = fakeLayout();
    const signin = new PhoneSignIn(L, {}, { overrides: async () => [{ provider: "anthropic", plugin: "Acme Bridge" }] });
    signin.L = { ...L, state: join(L.root, "state.json") };
    const list = await signin.list();
    const claude = list.find((o) => o.provider === "anthropic" && o.method === "paste-code");
    assert.equal(claude.badge, "UNOFFICIAL");
    await assert.rejects(signin.start({ optionId: claude.id }), /Claude login through Acme Bridge: confirm first/);
    // A broken detector falls back to the plain list.
    const broken = new PhoneSignIn(L, {}, { overrides: async () => Promise.reject(new Error("x")) });
    assert.equal((await broken.list()).find((o) => o.id === claude.id).badge, "EXTRA USAGE");
  });

  it("'Already signed in' names the sign-in as the list does, not pi's provider id", async () => {
    const L = fakeLayout();
    const list = await signInOptions(L.app, {}, { overrides: [{ provider: "anthropic", plugin: "Acme Relay" }] });
    const auth = { "openai-codex": { type: "oauth" }, anthropic: { type: "oauth" }, openai: { type: "api_key" }, "some-new-provider": { type: "oauth" } };
    assert.deepEqual(signedInLabels(list, Object.keys(auth), auth), ["ChatGPT (Codex)", "Claude login (your plan, via Acme Relay)", "OpenAI API key", "some-new-provider"]);
    assert.deepEqual(signedInLabels(list, ["anthropic"], { anthropic: { type: "api_key" } }), ["Anthropic API key"]);
  });

  const botsDir = process.env.DINOBOT_TEST_BOTS_DIR;
  it("the bundled bots plugin's wording (shared/sign-in.ts) is the one used", { skip: botsDir ? false : "set DINOBOT_TEST_BOTS_DIR" }, async () => {
    const L = fakeLayout();
    mkdirSync(join(L.app, "bots"), { recursive: true });
    symlinkSync(join(botsDir, "shared"), join(L.app, "bots", "shared"));
    const via = await signInOptions(L.app, {}, { overrides: [{ provider: "anthropic", plugin: "Acme Bridge" }] });
    const c1 = via.find((o) => o.provider === "anthropic" && o.method === "paste-code");
    const { claudeViaPlugin } = await import(join(botsDir, "shared", "sign-in.ts"));
    assert.deepEqual({ label: c1.label, note: c1.note, badge: c1.badge, confirm: c1.confirm }, claudeViaPlugin("Acme Bridge"));
  });
});

const PI_VERSION = readFileSync(join(ROOT, "build", "build-tarball.sh"), "utf8").match(/PI_VERSION=\$\{PI_VERSION-([\d.]+)\}/)?.[1];
const PI_DIR = process.env.DINOBOT_TEST_PI_DIR || join(ROOT, ".cache", `pi-${PI_VERSION}`, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
describe("the real probe (pi loads the plugins)", { skip: existsSync(join(PI_DIR, "dist", "index.js")) ? false : `no pi at ${PI_DIR}` }, () => {
  it("finds a plugin that registers anthropic, ignores one with a new provider and plain extensions", async () => {
    const L = fakeLayout();
    symlinkSync(PI_DIR, join(L.app, "pi"));
    const replacing = join(L.root, "plugins", "acme-claude-bridge");
    writePlugin(
      replacing,
      "acme-claude-bridge",
      `import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export default function (pi: any) {
  const anthropic = builtinProviders().find((p: any) => p.id === "anthropic");
  pi.registerProvider({ ...anthropic });
}
`,
    );
    const adding = join(L.root, "plugins", "acme-local");
    writePlugin(adding, "acme-local", `export default function (pi: any) { pi.registerProvider("acme-local", { baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "x", models: [] }); }\n`);
    const plain = join(L.root, "plugins", "plain");
    writePlugin(plain, "plain-tool", `export default function (_pi: any) {}\n`);
    writeFileSync(join(L.piAgentDir, "settings.json"), JSON.stringify({ packages: [replacing, adding, plain] }));
    const found = await providerOverrides(L, { fresh: true });
    assert.deepEqual(found.find((o) => o.provider === "anthropic")?.plugin, "Acme Claude Bridge");
    assert.equal(found.some((o) => o.plugin === "Plain Tool"), false);
    // Without the replacing plugin: no anthropic override.
    writeFileSync(join(L.piAgentDir, "settings.json"), JSON.stringify({ packages: [adding, plain] }));
    const none = await providerOverrides(L, { fresh: true });
    assert.equal(none.some((o) => o.provider === "anthropic"), false);
  });
});

describe("tarball guard", () => {
  // The real names live outside the repo (DINOBOT_PRIVATE_GUARD / ~/.config/dinobot/private-guard.txt).
  const PATTERNS = "# test names\nsecret[-_ ]?plugin\nPRIVATE_PROXY_URL\nsecret-bots-repo\n";
  it("refuses a private name anywhere (README, docs, node_modules, any spelling); passes a clean tree", async () => {
    const { spawnSync } = await import("node:child_process");
    const guard = join(ROOT, "build", "private-guard.sh");
    const env = { ...process.env, DINOBOT_PRIVATE_GUARD: PATTERNS };
    const clean = tmp();
    mkdirSync(join(clean, "node_modules", "x"), { recursive: true });
    writeFileSync(join(clean, "README.md"), "Provider plugins replace pi's anthropic provider.\n");
    assert.equal(spawnSync("sh", [guard, clean], { env }).status, 0);
    for (const [file, text] of [
      ["README.md", "add secret-plugin first"],
      ["docs/x.md", "Secret Plugin"],
      ["node_modules/x/index.js", "SECRET_PLUGIN"],
      ["bots/shared/sign-in.ts", "secretplugin"],
      ["installer/lib/a.mjs", "PRIVATE_PROXY_URL"],
    ]) {
      const d = tmp();
      mkdirSync(join(d, file, ".."), { recursive: true });
      writeFileSync(join(d, file), text);
      const r = spawnSync("sh", [guard, d], { encoding: "utf8", env });
      assert.equal(r.status, 1, file);
      assert.match(r.stdout, new RegExp(file.replace(/[.]/g, "\\.")));
    }
  });
  it("no patterns: passes with a warning, or refuses when DINOBOT_REQUIRE_GUARD=1", async () => {
    const { spawnSync } = await import("node:child_process");
    const guard = join(ROOT, "build", "private-guard.sh");
    const d = tmp();
    const none = { ...process.env, DINOBOT_PRIVATE_GUARD: "", DINOBOT_PRIVATE_GUARD_FILE: join(d, "missing.txt") };
    const r = spawnSync("sh", [guard, d], { encoding: "utf8", env: none });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no patterns set; check skipped/);
    assert.equal(spawnSync("sh", [guard, d], { env: { ...none, DINOBOT_REQUIRE_GUARD: "1" } }).status, 1);
  });
});
