// SL1: the terminal sign-in step (setup --signin-here and `dinobot signin`).
// v0.1.5 bug: prompter.choose ran inside options.find's callback, so picking option N showed the
// menu N times; Claude login (last, via a provider plugin) looked like an endless loop with no confirm.
// node --test test/signin-loop.test.mjs  (temp dirs under ./.test-tmp-sl, never /tmp; no network)
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { providerOverrides } from "../lib/provider-overrides.mjs";
import { chooseAndSignIn, defaultOption, findOption, signInOptions } from "../lib/signin.mjs";
import { Prompter } from "../lib/util.mjs";
import { signin, USAGE } from "../lib/cli.mjs";

const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".test-tmp-sl");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

// A fake pi-ai: Anthropic's copy-code login (method select, link, pasted code), no network.
const FAKE_PI_AI = `
export function builtinProviders() {
  return [{ id: "anthropic", auth: { oauth: { login: async ({ prompt, notify }) => {
    const method = await prompt({ type: "select", message: "Login method", options: [{ id: "browser", label: "Browser" }, { id: "copy-code", label: "Copy code" }] });
    if (method !== "copy-code") throw new Error("expected the copy-code method, got " + method);
    notify({ type: "auth_url", url: "https://claude.example/oauth/authorize?fixture=1", instructions: "Copy the code Anthropic shows." });
    const code = await prompt({ type: "text", message: "Paste the code" });
    return { refresh: "refresh-" + code, access: "access-" + code, expires: 4102444800000 };
  } } } }];
}`;

/** Throwaway DinoBot layout: the bundled plugin's real sign-in table, a fake pi-ai, and a fixture
 * provider plugin ("Pi Fixture") that replaces pi's anthropic provider. */
async function rig() {
  const root = mkdtempSync(join(TMP, "h-"));
  const app = join(root, ".dinobot", "app");
  const L = { home: root, root: join(root, ".dinobot"), app, bin: join(root, ".dinobot", "bin"), piAgentDir: join(root, ".dinobot", "pi"), userPiDir: join(root, ".pi", "agent") };
  mkdirSync(join(app, "bots", "shared"), { recursive: true });
  copyFileSync(join(ROOT, "plugins", "bots", "shared", "sign-in.ts"), join(app, "bots", "shared", "sign-in.ts"));
  const piAi = join(app, "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "providers");
  mkdirSync(piAi, { recursive: true });
  writeFileSync(join(piAi, "all.js"), FAKE_PI_AI);
  const plugin = join(root, "plugins", "pi-fixture");
  mkdirSync(join(plugin, "extensions"), { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "pi-fixture", version: "0.1.0", keywords: ["pi-package"], pi: { extensions: ["./extensions/pi-fixture.ts"] } }));
  writeFileSync(join(plugin, "extensions", "pi-fixture.ts"), "export default (pi) => pi.registerProvider({ id: 'anthropic' });\n");
  mkdirSync(L.piAgentDir, { recursive: true });
  writeFileSync(join(L.piAgentDir, "settings.json"), JSON.stringify({ packages: [plugin] }));
  // pi's probe is faked: it reports what pi would (this plugin registers "anthropic").
  const probe = async () => ({ registrations: [{ provider: "anthropic", extensionPath: join(plugin, "extensions", "pi-fixture.ts"), baseDir: plugin }], errors: [] });
  const overrides = await providerOverrides(L, { probe, fresh: true });
  const options = await signInOptions(app, {}, { overrides });
  return { L, options, overrides, auth: () => JSON.parse(readFileSync(join(L.piAgentDir, "auth.json"), "utf8")) };
}

function sink() {
  const s = { text: "", write: (d) => ((s.text += d), true) };
  return s;
}
const menus = (text) => text.split("\nSign in with\n").length - 1;
const lastMenu = (text) => text.slice(text.lastIndexOf("\nSign in with\n")).split("Choose a number:")[0];

describe("setup's sign-in step (chooseAndSignIn)", () => {
  it("the fixture plugin turns option 6 into 'Claude login (your plan, via Pi Fixture)'", async () => {
    const { options, overrides } = await rig();
    assert.deepEqual(overrides.map((o) => [o.provider, o.plugin]), [["anthropic", "Pi Fixture"]]);
    assert.equal(options.length, 6);
    assert.equal(options[5].label, "Claude login (your plan, via Pi Fixture)");
    assert.equal(options[5].badge, "UNOFFICIAL");
  });

  it("picking 6 shows the menu once, then the confirm, the link, and saves the Claude credential", async () => {
    const { L, options, auth } = await rig();
    const out = sink();
    const prompter = new Prompter({ input: ["6", "y", "the-code#state"], output: out });
    const done = await chooseAndSignIn(L, prompter, { options, def: defaultOption(options, {}), out });
    assert.equal(menus(out.text), 1, out.text);
    assert.match(out.text, /Claude login through Pi Fixture\n/);
    assert.match(out.text, /Open this link \(on your phone is fine\):\n {2}https:\/\/claude\.example\/oauth\/authorize\?fixture=1/);
    assert.deepEqual(prompter.asked, ["signin", "confirm:anthropic:paste-code", "oauth:anthropic"], "scripted answers do not echo questions: the confirm was asked before the code");
    assert.ok(out.text.indexOf("Claude login through") < out.text.indexOf("Open this link"), "confirm text before the link");
    assert.equal(done.provider, "anthropic");
    assert.equal(done.option.id, options[5].id);
    assert.deepEqual(auth().anthropic, { type: "oauth", refresh: "refresh-the-code#state", access: "access-the-code#state", expires: 4102444800000 });
    assert.deepEqual(prompter.input, [], "every scripted answer used, no extra question");
  });

  for (const n of [2, 3, 4, 5]) {
    it(`picking ${n} asks the menu once (regression: v0.1.5 asked it ${n} times)`, async () => {
      const { L, options, auth } = await rig();
      const out = sink();
      const want = options[n - 1];
      const input = [String(n), ...(want.method === "api-key" ? ["sk-fixture"] : [])];
      const prompter = new Prompter({ input, output: out });
      if (want.method !== "api-key") {
        // ChatGPT/Copilot logins are not in the fake pi-ai: the step must say so, after one menu.
        await assert.rejects(chooseAndSignIn(L, prompter, { options, out }), /pi has no login for/);
      } else {
        const done = await chooseAndSignIn(L, prompter, { options, out });
        assert.equal(done.option.id, want.id);
        assert.deepEqual(auth()[want.provider], { type: "api_key", key: "sk-fixture" });
      }
      assert.equal(menus(out.text), 1, out.text);
    });
  }

  it("a refused confirm gives one re-pick, without the Claude login; never a third menu", async () => {
    const { L, options, auth } = await rig();
    const out = sink();
    const prompter = new Prompter({ input: ["6", "n", "4", "sk-ant-fixture"], output: out });
    const done = await chooseAndSignIn(L, prompter, { options, out });
    assert.equal(menus(out.text), 2, out.text);
    const second = lastMenu(out.text);
    assert.doesNotMatch(second, /Claude login/);
    assert.equal(second.match(/^ {2}\d+\./gm).length, 5);
    assert.equal(done.option.label, "Anthropic API key");
    assert.deepEqual(auth().anthropic, { type: "api_key", key: "sk-ant-fixture" });
  });

  it("Enter picks the default (never the Claude login)", async () => {
    const { L, options } = await rig();
    const out = sink();
    const prompter = new Prompter({ input: [""], output: out });
    await assert.rejects(chooseAndSignIn(L, prompter, { options, out }), /pi has no login for openai-codex/);
    assert.equal(menus(out.text), 1);
  });

  it("setup uses this step: no prompter.choose inside a find/filter callback anywhere in lib/", () => {
    for (const f of ["cli.mjs", "signin.mjs", "phone-signin.mjs"]) {
      const src = readFileSync(join(ROOT, "lib", f), "utf8");
      assert.doesNotMatch(src, /\.(find|filter|some|every)\([^;]*=>[^;]*prompter\.(choose|ask)\(/, f);
    }
    assert.match(readFileSync(join(ROOT, "lib", "cli.mjs"), "utf8"), /await chooseAndSignIn\(L, prompter, \{ options, def \}\)/);
  });
});

describe("dinobot signin", () => {
  const overridesOf = (o) => async () => o;

  it("no argument: the same menu; adds Claude next to an existing sign-in (never skipped as signed in)", async () => {
    const { L, overrides, auth } = await rig();
    writeFileSync(join(L.piAgentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "keep-me" } }));
    const out = sink();
    const prompter = new Prompter({ input: ["6", "y", "code-1"], output: out });
    const done = await signin(L, { _: ["signin"] }, { prompter, out, overrides: overridesOf(overrides) });
    assert.equal(done.provider, "anthropic");
    assert.equal(menus(out.text), 1);
    assert.match(out.text, /Claude login through Pi Fixture/);
    assert.match(out.text, /Signed in: Claude login \(your plan, via Pi Fixture\)\. Saved for your bots in .*auth\.json/);
    assert.equal(auth()["openai-codex"].access, "keep-me", "other sign-ins kept");
    assert.equal(auth().anthropic.type, "oauth");
  });

  it("with a provider: straight to it (claude/anthropic = login; --api-key = the key); replaces only that provider", async () => {
    const { L, overrides, auth } = await rig();
    writeFileSync(join(L.piAgentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "old" }, openrouter: { type: "api_key", key: "or" } }));
    let out = sink();
    const p2 = new Prompter({ input: ["y", "code-2"], output: out });
    await signin(L, { _: ["signin", "anthropic"] }, { prompter: p2, out, overrides: overridesOf(overrides) });
    assert.equal(menus(out.text), 0, "no menu with a provider");
    assert.deepEqual(p2.asked, ["confirm:anthropic:paste-code", "oauth:anthropic"]);
    assert.equal(auth().anthropic.access, "access-code-2");
    assert.equal(auth().openrouter.key, "or");
    out = sink();
    await signin(L, { _: ["signin", "anthropic"], "api-key": true }, { prompter: new Prompter({ input: ["sk-new"], output: out }), out, overrides: overridesOf(overrides) });
    assert.doesNotMatch(out.text, /Claude login through/);
    assert.deepEqual(auth().anthropic, { type: "api_key", key: "sk-new" });
  });

  it("a refused confirm with a provider: not signed in, exit 1, nothing saved", async () => {
    const { L, overrides } = await rig();
    const out = sink();
    const before = process.exitCode;
    await signin(L, { _: ["signin", "claude"] }, { prompter: new Prompter({ input: ["n"], output: out }), out, overrides: overridesOf(overrides) });
    assert.match(out.text, /Not signed in \(not confirmed\)\./);
    assert.equal(process.exitCode, 1);
    process.exitCode = before;
    assert.throws(() => readFileSync(join(L.piAgentDir, "auth.json")), /ENOENT/);
  });

  it("an unknown provider lists the choices", async () => {
    const { L, overrides } = await rig();
    await assert.rejects(signin(L, { _: ["signin", "nope"] }, { out: sink(), overrides: overridesOf(overrides) }), /no sign-in called "nope"\. Choices: openai-codex, github-copilot, openrouter, anthropic, openai/);
  });

  it("--list / status: the signed-in providers in the list's words (pi's readiness check faked)", async () => {
    const { L, overrides } = await rig();
    writeFileSync(join(L.piAgentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" }, openrouter: { type: "api_key", key: "x" }, openai: { type: "api_key", key: "bad" } }));
    const readyProviders = async () => ["anthropic", "openrouter"];
    let out = sink();
    await signin(L, { _: ["signin"], list: true }, { out, readyProviders, overrides: overridesOf(overrides) });
    assert.equal(out.text, "Signed in:\n  Claude login (your plan, via Pi Fixture)  (anthropic, login)\n  OpenRouter  (openrouter, API key)\n");
    out = sink();
    await signin(L, { _: ["signin", "status"] }, { out, readyProviders: async () => [], overrides: overridesOf(overrides) });
    assert.match(out.text, /^No AI sign-in yet\. Run: dinobot signin/);
  });

  it("help and the usage list mention it", async () => {
    const out = sink();
    await signin({}, { _: ["signin"], help: true }, { out, overrides: async () => [] }).catch(() => null);
    assert.match(out.text, /dinobot signin <provider>/);
    assert.ok(USAGE.some((l) => l.startsWith("dinobot signin --list")));
  });

  it("findOption: ids, provider ids, short names", async () => {
    const { options } = await rig();
    assert.equal(findOption(options, "claude").label, "Claude login (your plan, via Pi Fixture)");
    assert.equal(findOption(options, "anthropic", { apiKey: true }).label, "Anthropic API key");
    assert.equal(findOption(options, "codex").provider, "openai-codex");
    assert.equal(findOption(options, options[2].id).provider, "openrouter");
    assert.equal(findOption(options, "openrouter").method, "api-key");
    assert.equal(findOption(options, "nope"), null);
  });
});
