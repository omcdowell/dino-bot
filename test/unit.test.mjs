// Unit tests: node --test test/unit.test.mjs  (temp dirs under ./.test-tmp, never /tmp)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { botIdFor, createStarterBot, trashBot } from "../lib/bots.mjs";
import { readEnvFile, writeBotsSettings, writeDaemonConfig, writeDaemonEnv } from "../lib/config.mjs";
import { detectSignIns, isTailnetIp, lanIp, subscriptionFor } from "../lib/detect.mjs";
import { planGc } from "../lib/herdr.mjs";
import { buildOffer, desktopPairLines, offerEndpoints, offerUrl } from "../lib/offer.mjs";
import { launchdAgents, systemdUnits } from "../lib/service.mjs";
import { defaultOption } from "../lib/signin.mjs";
import { layout, Prompter } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp");
mkdirSync(TMP, { recursive: true });
const tmp = () => mkdtempSync(join(TMP, "t-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function fakeLayout() {
  const home = tmp();
  return layout({ HOME: home });
}

describe("offer", () => {
  it("tells desktop users the full pair --link command (with ~, ~/.dinobot/bin is not on PATH)", () => {
    const lines = desktopPairLines({ bin: "/home/sam/.dinobot/bin", home: "/home/sam" }, { product: "DinoBot", productId: "dinobot" });
    assert.match(lines[0], /DinoBot desktop app.*Paste pairing link/);
    assert.equal(lines[1], "  ~/.dinobot/bin/dinobot pair --link");
    const custom = desktopPairLines({ bin: "/opt/db/bin", home: "/home/sam" }, { product: "DinoBot", productId: "dinobot" });
    assert.equal(custom[1], "  /opt/db/bin/dinobot pair --link");
  });
  it("offers the tailnet only: MagicDNS name, then the tailnet IP (no .local, LAN or localhost)", () => {
    const eps = offerEndpoints({ port: 6767, tailscale: { running: true, dnsName: "box.tail1.ts.net", ip: "100.64.0.7" }, hostname: "box", lanIp: "192.168.1.20" });
    assert.deepEqual(eps, ["box.tail1.ts.net:6767", "100.64.0.7:6767"]);
  });
  it("offers nothing when Tailscale is not running", () => {
    assert.deepEqual(offerEndpoints({ port: 1, tailscale: { running: false, dnsName: "x", ip: "100.64.0.1" } }), []);
  });
  it("encodes a v3 offer the app parses (dinobot:// link, base64url JSON fragment)", () => {
    const offer = buildOffer({ serverId: "srv", daemonPublicKeyB64: "key", endpoints: ["h:1"], password: "pw" });
    const url = offerUrl(offer);
    assert.ok(url.startsWith("dinobot://pair/#offer="));
    const back = JSON.parse(Buffer.from(url.split("#offer=")[1], "base64url").toString("utf8"));
    assert.deepEqual(back, { v: 3, serverId: "srv", daemonPublicKeyB64: "key", endpoints: ["h:1"], password: "pw" });
  });
});

describe("detect", () => {
  it("maps sign-ins to rel-import subscriptions", () => {
    assert.equal(subscriptionFor("anthropic", "oauth", {}), "claude-pro");
    assert.equal(subscriptionFor("anthropic", "oauth", { DINOBOT_CLAUDE_PLAN: "max" }), "claude-max");
    assert.equal(subscriptionFor("anthropic", "api_key", {}), "anthropic-api");
    assert.equal(subscriptionFor("openai-codex", "oauth", {}), "chatgpt");
    assert.equal(subscriptionFor("github-copilot", "oauth", {}), "copilot");
    assert.equal(subscriptionFor("cursor", "api_key", {}), null);
  });
  it("finds pi logins and env keys, and never copies a Codex CLI login", () => {
    const L = fakeLayout();
    mkdirSync(L.piAgentDir, { recursive: true });
    writeFileSync(join(L.piAgentDir, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "a" }, cursor: { type: "api_key", key: "k" } }));
    mkdirSync(join(L.home, ".codex"));
    writeFileSync(join(L.home, ".codex", "auth.json"), JSON.stringify({ tokens: { refresh_token: "r" } }));
    const r = detectSignIns({ piAgentDir: L.piAgentDir, home: L.home, env: { OPENROUTER_API_KEY: "or-key" } });
    assert.deepEqual(r.found.map((f) => [f.subscription, f.source]), [["copilot", "pi"], ["openrouter", "env OPENROUTER_API_KEY"]]);
    assert.equal(r.codexCli, true);
    assert.equal(defaultOption([{ provider: "github-copilot" }, { provider: "openai-codex" }], r).provider, "openai-codex");
  });
  it("tells tailnet addresses apart and skips them as LAN", () => {
    assert.ok(isTailnetIp("100.127.255.1"));
    assert.ok(!isTailnetIp("100.20.1.1"));
    const iface = (address) => [{ address, family: "IPv4", internal: false }];
    assert.equal(lanIp({ tailscale0: iface("100.64.0.2"), docker0: iface("172.17.0.1"), wlan0: iface("192.168.0.9") }), "192.168.0.9");
  });
});

describe("config", () => {
  it("writes a private env file with a password it keeps on re-run", () => {
    const L = fakeLayout();
    const a = writeDaemonEnv(L, { port: 6768, listen: "100.64.0.7:6768", directEndpoints: ["box.ts.net:6768"] });
    assert.equal(statSync(L.envFile).mode & 0o777, 0o600);
    assert.equal(a.PASEO_LISTEN, "100.64.0.7:6768");
    assert.equal(a.PASEO_PAIR_LINK_SCHEME, "dinobot");
    assert.equal(a.PASEO_RELAY_ENABLED, "false");
    assert.equal(a.PASEO_DIRECT_E2EE, "required");
    assert.ok(a.PATH.startsWith(L.bin));
    const b = writeDaemonEnv(L, { port: 6768, listen: "100.64.0.7:6768", directEndpoints: [] });
    assert.equal(b.PASEO_PASSWORD, a.PASEO_PASSWORD);
    assert.equal(readEnvFile(L.envFile).PASEO_BOTS_ROOT, L.botsRoot);
  });
  it("daemon config: own PASEO_HOME, relay off, bots plugin and OptChat from ~/.dinobot only", () => {
    const L = fakeLayout();
    mkdirSync(L.paseoHome, { recursive: true });
    writeFileSync(join(L.paseoHome, "config.json"), JSON.stringify({ daemon: { terminalProfiles: [1] }, plugins: { other: { source: "npm" } } }));
    writeDaemonConfig(L, { mainModel: "openai-codex/gpt-6-sol" });
    const cfg = JSON.parse(readFileSync(join(L.paseoHome, "config.json"), "utf8"));
    assert.deepEqual(cfg.daemon.terminalProfiles, [1]);
    assert.equal(cfg.daemon.relay.enabled, false);
    assert.equal(cfg.daemon.agentProfiles[0].model, "openai-codex/gpt-6-sol");
    assert.equal(cfg.plugins.bots.path, join(L.app, "bots"));
    assert.ok(cfg.plugins.other);
    assert.ok(cfg.agents.providers.optchat.command.filter((p) => p.startsWith("/")).every((p) => p.startsWith(L.root)));
    assert.ok(!JSON.stringify(cfg).includes("/code/"));
  });
  it("bots settings carry both branch formats and keep the user's other keys", () => {
    const L = fakeLayout();
    mkdirSync(L.botsRoot, { recursive: true });
    writeFileSync(join(L.botsRoot, ".settings.json"), JSON.stringify({ extensions: ["/x.ts"], user: { aliases: ["sam"] } }));
    writeBotsSettings(L, { userName: "Sam", escalation: "juniper", defaultModel: "anthropic/claude-sonnet-5-5" });
    const s = JSON.parse(readFileSync(join(L.botsRoot, ".settings.json"), "utf8"));
    assert.deepEqual(s.user, { name: "Sam", aliases: ["sam"] });
    assert.equal(s.ownerName, "Sam");
    assert.equal(s.escalation, "juniper");
    assert.equal(s.escalationBot, "juniper");
    assert.deepEqual(s.herdr, { session: "paseo-bots" });
    assert.deepEqual(s.extensions, ["/x.ts"]);
  });
});

describe("services", () => {
  it("systemd units: daemon from the env file, a separate herdr session and a templated GC", () => {
    const L = fakeLayout();
    const u = systemdUnits(L);
    assert.match(u["dinobot.service"], new RegExp(`EnvironmentFile=${L.envFile}`));
    assert.match(u["dinobot-herdr.service"], /Environment=HERDR_SESSION=paseo-bots/);
    assert.match(u["dinobot-herdr-gc@.service"], /HERDR_SESSION=%i/);
    assert.match(u["dinobot-herdr-gc@.service"], /herdr-gc --session %i --apply/);
    assert.ok(!Object.values(u).join("").includes("sudo"));
  });
  it("launchd agents are valid-looking plists with RunAtLoad", () => {
    const L = fakeLayout();
    const a = launchdAgents(L);
    assert.equal(Object.keys(a).length, 3);
    assert.match(a["app.dinobot.daemon.plist"], /<key>RunAtLoad<\/key><true\/>/);
    assert.match(a["app.dinobot.herdr.plist"], /<string>paseo-bots<\/string>/);
  });
});

describe("herdr gc plan", () => {
  it("closes only old, unfocused workers", () => {
    const now = 2_000_000_000;
    const plan = planGc(
      [
        { name: `w-old-${now - 50 * 3600}`, pane_id: "p1" },
        { name: `w-new-${now - 3600}`, pane_id: "p2" },
        { name: `w-focus-${now - 99 * 3600}`, pane_id: "p3", focused: true },
        { name: "no-age", pane_id: "p4" },
      ],
      { nowSec: now, ttlSec: 48 * 3600 },
    );
    assert.deepEqual(plan.close.map((r) => r.pane_id), ["p1"]);
    assert.deepEqual(plan.keep.map((r) => r.action), ["keep_young", "skip_focused", "skip_no_age"]);
  });
});

describe("prompts", () => {
  it("counts only questions actually asked; presets and --yes ask nothing", () => {
    const p = new Prompter({ answers: { name: "Sam" }, input: ["", "2"] });
    assert.equal(p.ask("name", "Name?", "X"), "Sam");
    assert.deepEqual(p.checklist("extras", "Extras", [{ id: "coordinator", on: true, label: "c" }, { id: "import", on: false, label: "i" }]), { coordinator: true, import: false });
    assert.deepEqual(p.checklist("extras2", "Extras", [{ id: "coordinator", on: true, label: "c" }, { id: "import", on: false, label: "i" }]), { coordinator: true, import: true });
    assert.deepEqual(p.asked, ["extras", "extras2"]);
    const y = new Prompter({ assumeYes: true });
    assert.equal(y.choose("signin", "?", [{ id: "a" }, { id: "b" }], "b"), "b");
    assert.deepEqual(y.asked, []);
  });
});

describe("starter bot", () => {
  it("creates the plugin's bot layout, reuses it on re-run, and trashes instead of deleting", async () => {
    const L = fakeLayout();
    const models = {
      main: { provider: "openai-codex", model: "gpt-6-sol", thinking: "medium" },
      worker: { provider: "openai-codex", model: "gpt-6-sol", thinking: "medium" },
      compaction: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "low" },
    };
    const r = await createStarterBot(L, { models, subscription: "chatgpt" });
    assert.deepEqual(r, { botId: "juniper", created: true });
    const agents = readFileSync(join(L.optchatHome, "profiles", "juniper", "AGENTS.md"), "utf8");
    assert.match(agents, /^# Juniper/);
    assert.match(agents, /coordinator/);
    assert.doesNotMatch(agents, /bot-dm:begin|Bot-to-bot/, "AGENTS.md is the role only; the rules are the plugin's prompt section");
    const meta = JSON.parse(readFileSync(join(L.botsRoot, "juniper", ".bot.json"), "utf8"));
    assert.equal(meta.chat.provider, "optchat/openai-codex/gpt-6-sol");
    // The installer's pick is the host default, not the user's: the phone's "Choose models" must move it (paseo-bots onboarding.applyToBots).
    assert.equal(meta.chat.setup, true);
    const cfg = JSON.parse(readFileSync(join(L.optchatHome, "profiles", "juniper", "config.json"), "utf8"));
    assert.equal(cfg.subscription, "chatgpt");
    assert.equal(cfg.setup, true);
    assert.equal(cfg.compactor.model, "gpt-5.6-terra");
    assert.deepEqual(await createStarterBot(L, { models }), { botId: "juniper", created: false });
    const trash = trashBot(L, "juniper");
    assert.ok(existsSync(join(trash, "bot", ".bot.json")));
    assert.ok(existsSync(join(trash, "profile", "AGENTS.md")));
    assert.ok(!existsSync(join(L.botsRoot, "juniper")));
    assert.equal(botIdFor("Tweety Bird"), "tweety-bird");
  });
});

describe("cli output into a closed pipe", () => {
  it("`dinobot status | head` style: a reader that went away is not a crash (no EPIPE stack, exit 0)", async () => {
    const { spawn } = await import("node:child_process");
    const home = tmp();
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "lib", "cli.mjs"), "status"], {
      env: { PATH: process.env.PATH, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.destroy(); // the reader is gone before the first line is written
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
    assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error' event/);
    assert.equal(code, 0);
  });
});
