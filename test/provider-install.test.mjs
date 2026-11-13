// Adding a provider from the app (bots plugin provider.* RPCs -> lib/provider-install.mjs).
// node --test test/provider-install.test.mjs  (temp dirs under ./.test-tmp-pinst, never /tmp)
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fromPackage, ProviderJobs, scrub, signInOptionFor, validateInstallRequest } from "../lib/provider-install.mjs";
import { readTokens } from "../lib/providers.mjs";
import { layout } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-pinst");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
// Fake, per the brief (github_pat_TEST), padded to the 20 characters a token needs.
const TOKEN = "github_pat_TEST_000000000000";
const SRC = "git:github.com/acme/claude-plugin@v1.0.0";

/** A DinoBot home whose bin/pi is a script: logs its args (never its env) and does what `mode` says. */
function home(mode = "ok") {
  const h = mkdtempSync(join(TMP, "h-"));
  const L = layout({ HOME: h, DINOBOT_HOME: join(h, ".dinobot") });
  mkdirSync(L.bin, { recursive: true });
  const script = {
    ok: `echo "$@" >> "${h}/pi-args"; exit 0`,
    // git failing and echoing its credentials (the worst case): the token must not reach the app.
    leak: `echo "$@" >> "${h}/pi-args"; echo "fatal: could not read from https://x-access-token:$DINOBOT_GIT_TOKEN@github.com/acme/claude-plugin" >&2; exit 128`,
  }[mode];
  writeFileSync(join(L.bin, "pi"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(L.bin, "pi"), 0o755);
  return { h, L };
}

const OPTIONS = [
  { id: "openai-codex:oauth:0", provider: "openai-codex", method: "oauth", label: "ChatGPT" },
  { id: "anthropic:oauth:3", provider: "anthropic", method: "oauth", label: "Claude login (your plan, via Acme Claude)" },
  { id: "anthropic:api-key:4", provider: "anthropic", method: "api-key", label: "Anthropic API key" },
];

describe("what the app may send", () => {
  it("takes npm and pinned github.com sources, normalised", () => {
    assert.equal(validateInstallRequest({ source: SRC, token: TOKEN }).source, "git:https://github.com/acme/claude-plugin@v1.0.0");
    assert.equal(validateInstallRequest({ source: "npm:pi-web-access@0.45.0" }).source, "npm:pi-web-access@0.45.0");
    assert.equal(validateInstallRequest({ source: "npm:x", name: "  Web  " }).name, "Web");
  });
  it("refuses folders, other hosts, unpinned git, arbitrary URLs and junk", () => {
    for (const source of ["./pkg", "/etc", "~/x", "git:gitlab.com/o/r@v1", "https://evil.example/o/r@v1", "git:github.com/o/r", "http://github.com/o/r@v1", "npm:$(id)", "rm -rf /", ""]) {
      assert.throws(() => validateInstallRequest({ source }), undefined, source);
    }
  });
  it("refuses a token on npm and a malformed token, without echoing it", () => {
    assert.throws(() => validateInstallRequest({ source: "npm:x", token: TOKEN }), (e) => /only goes with a git/.test(e.message) && !e.message.includes(TOKEN));
    assert.throws(() => validateInstallRequest({ source: SRC, token: "github_pat_TEST;rm" }), (e) => /does not look right/.test(e.message) && !e.message.includes("github_pat_TEST"));
  });
  it("install() errors are scrubbed too", () => {
    const jobs = new ProviderJobs(home().L);
    assert.throws(() => jobs.install({ source: "npm:x", token: TOKEN }), (e) => !e.message.includes(TOKEN));
  });
});

describe("helpers", () => {
  it("scrub removes the request token and GitHub token shapes", () => {
    assert.equal(scrub(`a ${TOKEN} b ghp_abcdefghijklmnop c`, TOKEN), "a *** b *** c");
    assert.equal(scrub("github_pat_ZZZ_other", null), "***");
  });
  it("fromPackage matches pi's install dirs", () => {
    const git = validateInstallRequest({ source: SRC }).parsed;
    assert.ok(fromPackage("/h/.dinobot/pi/git/github.com/acme/claude-plugin/extensions/claude-plugin.ts", git));
    assert.ok(!fromPackage("/h/.dinobot/pi/git/github.com/acme/claude-pluginish/x.ts", git));
    const npm = validateInstallRequest({ source: "npm:@s/pkg@1.2.3" }).parsed;
    assert.ok(fromPackage("/h/.dinobot/pi/npm/node_modules/@s/pkg/index.ts", npm));
    assert.ok(!fromPackage(null, npm));
  });
  it("signInOptionFor prefers the login, or matches an API key sign-in", () => {
    assert.equal(signInOptionFor(OPTIONS, "anthropic").id, "anthropic:oauth:3");
    assert.equal(signInOptionFor(OPTIONS, "anthropic", "api_key").id, "anthropic:api-key:4");
    assert.equal(signInOptionFor(OPTIONS, "custom-x"), null);
  });
});

describe("install job", () => {
  it("installs with pi (same path as `dinobot provider add`), keeps the token 0600, refreshes models, and ends at the sign-in the new provider needs", async () => {
    const { h, L } = home("ok");
    let refreshed = 0;
    let freshProbe = false;
    const jobs = new ProviderJobs(L, {
      overrides: async ({ fresh }) => {
        freshProbe ||= fresh;
        return [{ provider: "anthropic", plugin: "Acme Claude", extensionPath: join(L.piAgentDir, "git/github.com/acme/claude-plugin/extensions/claude-plugin.ts") }];
      },
      signInOptions: async () => OPTIONS,
      authCheck: async () => ({ status: "not_ready" }),
      refreshCatalog: async () => (refreshed++, { ok: true }),
    });
    const first = jobs.install({ source: SRC, token: TOKEN, name: "Acme Claude" });
    assert.equal(first.state, "running");
    assert.equal(first.step, "installing");
    assert.throws(() => jobs.install({ source: "npm:x" }), /Another provider/);
    const done = await jobs.wait(first.jobId);
    assert.equal(done.state, "done", done.error ?? "");
    assert.deepEqual(done.providers, [{ provider: "anthropic", plugin: "Acme Claude", ready: false, optionId: "anthropic:oauth:3", label: "Claude login (your plan, via Acme Claude)" }]);
    assert.equal(refreshed, 1);
    assert.ok(freshProbe);
    assert.equal(readFileSync(join(h, "pi-args"), "utf8").trim(), "install git:https://github.com/acme/claude-plugin@v1.0.0");
    assert.equal(readTokens(L)["github.com/acme/claude-plugin"], TOKEN);
    assert.equal(statSync(join(L.root, "secrets", "git-tokens.json")).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(done).includes(TOKEN));
    // Done: the next install may start.
    assert.equal(jobs.install({ source: "npm:pi-x@1.0.0" }).state, "running");
  });

  it("a failed install never hands the token back, even when git prints it", async () => {
    const { L } = home("leak");
    const jobs = new ProviderJobs(L);
    const s = await jobs.wait(jobs.install({ source: SRC, token: TOKEN }).jobId);
    assert.equal(s.state, "error");
    assert.match(s.error, /Could not add/);
    assert.ok(!s.error.includes(TOKEN), s.error);
    assert.ok(!JSON.stringify(s).includes("github_pat_"));
    assert.equal(readTokens(L)["github.com/acme/claude-plugin"], undefined); // a token that failed is not kept
  });

  it("a provider already signed in is ready at once", async () => {
    const { L } = home("ok");
    const jobs = new ProviderJobs(L, {
      overrides: async () => [{ provider: "anthropic", plugin: "Acme Claude", extensionPath: `${L.piAgentDir}/git/github.com/acme/claude-plugin/x.ts` }],
      signInOptions: async () => OPTIONS,
      authCheck: async () => ({ status: "ready" }),
    });
    const s = await jobs.wait(jobs.install({ source: SRC }).jobId);
    assert.equal(s.providers[0].ready, true);
  });
});

describe("list and remove", () => {
  it("lists packages and the providers that matter (signed in, or registered by a package)", async () => {
    const { L } = home("ok");
    const removed = [];
    const jobs = new ProviderJobs(L, {
      listPackages: () => [{ source: "npm:pi-web-access", bundled: true }, { source: "git:github.com/acme/claude-plugin@v1.0.0", bundled: false }],
      overrides: async () => [{ provider: "anthropic", plugin: "Acme Claude", extensionPath: "/x" }],
      signInOptions: async () => OPTIONS,
      authTypes: () => ({ "openai-codex": "oauth" }),
      authCheck: async (p) => ({ status: p === "openai-codex" ? "ready" : "not_ready" }),
      removeProvider: async (source) => (removed.push(source), { removed: source }),
    });
    const r = await jobs.list();
    assert.equal(r.packages.length, 2);
    assert.deepEqual(
      r.providers.map((p) => [p.provider, p.ready, p.optionId, p.plugin]),
      [
        ["openai-codex", true, "openai-codex:oauth:0", null],
        ["anthropic", false, "anthropic:oauth:3", "Acme Claude"],
      ],
    );
    await assert.rejects(jobs.remove({ source: "npm:pi-web-access" }), /comes with the app/);
    await assert.rejects(jobs.remove({ source: "npm:not-there" }), /not added/);
    assert.deepEqual(await jobs.remove({ source: "git:https://github.com/acme/claude-plugin@v1.0.0" }), { removed: "git:https://github.com/acme/claude-plugin@v1.0.0" });
    assert.deepEqual(removed, ["git:https://github.com/acme/claude-plugin@v1.0.0"]);
  });
});
