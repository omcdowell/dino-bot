// Release boundary (TestFlight): host settings, the user party and its aliases, no default
// escalation bot, add-ons, and the bots' own herdr instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, botEnv, loadSettings, parseSettings, readSettings, settingsPath, writeRoomFullTools } from "../server/settings";
import { USER, isUserParty, normalizeParty, setUserAliases, setUserName, userName } from "../shared/party";
import { parseEnvelope, parseLedgerLine } from "../shared/dm-schema";
import { checkAllowed, isBotName } from "../bot-dm/policy";
import { Extensions } from "../server/extensions";
import { HerdrInstance, herdrEnv, parseSessionList } from "../server/herdr-instance";
import { DEFAULT_CHAT_CONFIG, chatConfig, setDefaultChatModel } from "../server/bots";

test("settings: no file gives the public defaults (no name, no escalation bot, own herdr instance, no add-ons)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-settings-"));
  const s = readSettings({ PASEO_BOTS_ROOT: dir });
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.equal(s.escalation, null);
  assert.equal(s.herdr.session, "paseo-bots");
  assert.equal(settingsPath({ PASEO_BOTS_ROOT: dir }), join(dir, ".settings.json"));
  assert.equal(settingsPath({ PASEO_BOTS_SETTINGS: "/x/s.json" }), "/x/s.json");
});

test("settings: values are read; bad ones fall back one key at a time; relative add-on paths resolve from the file", () => {
  const s = parseSettings(
    {
      user: { name: "  Sam ", aliases: ["SAM", "user", "bad alias", 3] },
      escalation: "coordinator",
      defaultModel: "openai-codex/gpt-5",
      models: { bots: { provider: "openai-codex", model: "gpt-6-sol", thinking: "high" }, compaction: { provider: "x", model: "y", thinking: "loud" }, workers: { model: "no-provider" } },
      herdr: { session: null },
      extensions: ["addon/index.ts", "/abs/x.ts"],
    },
    "/home/u/bots",
  );
  assert.deepEqual(s, {
    user: { name: "Sam", aliases: ["sam"] },
    escalation: "coordinator",
    defaultModel: "openai-codex/gpt-5",
    // A bad effort drops to null (no effort); a pick without a provider is no pick.
    models: { bots: { provider: "openai-codex", model: "gpt-6-sol", thinking: "high" }, compaction: { provider: "x", model: "y", thinking: null }, workers: null },
    herdr: { session: null },
    rooms: { fullTools: false },
    extensions: ["/home/u/bots/addon/index.ts", "/abs/x.ts"],
    addons: {},
  });
  const bad = parseSettings({ escalation: "Not A Bot!", herdr: { session: "a b" }, user: { name: 5 } });
  assert.equal(bad.escalation, null);
  assert.equal(bad.herdr.session, "paseo-bots");
  assert.equal(bad.user.name, "the user");
  assert.deepEqual(botEnv(s), { BOTS_USER_NAME: "Sam", BOTS_USER_ALIASES: "sam", BOTS_ESCALATE_TO: "coordinator", BOTS_WORKER_MODEL: "" });
  assert.equal(botEnv({ ...s, models: { ...s.models, workers: { provider: "openrouter", model: "z-ai/glm-5", thinking: "low" } } }).BOTS_WORKER_MODEL, "openrouter/z-ai/glm-5:low");
});

test("party: aliases read as USER in ledgers and envelopes; old 'sam' lines stay the user's on a host with that alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-settings-"));
  writeFileSync(join(dir, ".settings.json"), JSON.stringify({ user: { name: "Sam", aliases: ["sam"] } }));
  loadSettings({ PASEO_BOTS_ROOT: dir });
  assert.equal(isUserParty("sam"), true);
  assert.equal(normalizeParty("Sam"), USER);
  assert.equal(isBotName("sam"), false, "an alias is not a bot");
  const line = '{"v":1,"type":"message","id":"01K6ZQ5V8M0000000000000004","ts":"2026-10-08T06:30:00.000Z","from":"sam","to":"bitzer","kind":"info","thread":"01K6ZQ5V8M0000000000000001","re":"01K6ZQ5V8M0000000000000002","hop":2,"subject":"Thanks","body":"Thanks.","attachments":[],"expects_reply":false,"from_agent_id":null,"to_agent_id":null,"origin":"paseo-bots/dms-1"}';
  const parsed = parseLedgerLine(line);
  assert.ok(parsed.ok && parsed.record.type === "message", JSON.stringify(parsed));
  assert.equal(parsed.record.from, USER);
  const env = parseEnvelope("[dm 01K6ZQ5V8M00000000000000AA from sam to bitzer kind=info hop=0 re=-]");
  assert.equal(env?.from, USER);
  setUserAliases([]);
  assert.equal(isUserParty("sam"), false, "without the alias it is just a name");
});

test("user name: default 'the user', set from the settings", () => {
  setUserName("");
  assert.equal(userName(), "the user");
  setUserName("Sam");
  assert.equal(userName(), "Sam");
  setUserName("the user");
});

test("escalation: no escalation bot on a fresh host refuses escalate with advice; PM rules still apply", () => {
  const r = checkAllowed("ann", "bob", "escalate", "");
  assert.equal(r?.code, "not_allowed");
  assert.match(r!.reason, /no escalation bot/);
  assert.equal(checkAllowed("ann", "bob", "request", ""), null);
  assert.equal(checkAllowed("ann", "coordinator", "escalate", "coordinator"), null);
});

test("default chat model: none unless the defaultModel setting names one", async () => {
  const paseo = { config: { get: async () => ({}) } };
  assert.deepEqual(await chatConfig(paseo as never), DEFAULT_CHAT_CONFIG);
  // No hard-coded effort: only what setup chose (Sam, 27 Oct).
  setDefaultChatModel("openrouter/z-ai/glm-5");
  assert.deepEqual(await chatConfig(paseo as never), { provider: "optchat/openrouter/z-ai/glm-5" });
  setDefaultChatModel("openai-codex/gpt-6-sol", "high");
  assert.deepEqual(await chatConfig(paseo as never), { provider: "optchat/openai-codex/gpt-6-sol", thinkingOptionId: "high" });
  // A "bot" profile without a model (DinoBot's installer) defers to the host's choice.
  const modelless = { config: { get: async () => ({ daemon: { agentProfiles: [{ id: "bot", provider: "optchat" }] } }) } };
  assert.deepEqual(await chatConfig(modelless as never), { provider: "optchat/openai-codex/gpt-6-sol", thinkingOptionId: "high" });
  setDefaultChatModel(null);
});

test("add-ons: none by default (no usage source, empty quota); a loaded add-on registers usage, quota and a workers listener; a broken one is skipped", async () => {
  const registered: string[] = [];
  const server = { registerUsageSource: (s: { id: string }) => registered.push(s.id) } as never;
  const none = new Extensions({ settings: DEFAULT_SETTINGS, server });
  none.load();
  assert.equal(none.hasQuota(), false);
  assert.deepEqual(await none.quota(), { windows: [], error: "no usage source on this host" });
  await assert.rejects(none.report());

  const seen: unknown[] = [];
  const logs: string[] = [];
  const ext = new Extensions({
    settings: { ...DEFAULT_SETTINGS, extensions: ["/a.ts", "/broken.ts"] },
    server,
    log: (m) => logs.push(m),
    importer: (path) => {
      if (path === "/broken.ts") throw new Error("boom");
      return {
        default: (api: import("../server/extensions").BotsExtensionApi) => {
          api.registerUsageSource({ id: "x" } as never);
          api.setQuotaReader(async () => ({
            status: "available",
            windows: [{ id: "weekly", label: "Weekly (blocked)", shortLabel: "wk", usedPct: 100, remainingPct: 0, resetsAt: null, tone: "danger" }],
          }));
          api.onWorkers((bots) => seen.push(bots));
          return () => seen.push("stopped");
        },
      };
    },
  });
  ext.load();
  assert.deepEqual(ext.loaded, ["/a.ts"]);
  assert.match(logs.join("\n"), /\/broken\.ts not loaded: boom/);
  assert.deepEqual(registered, ["x"]);
  assert.deepEqual(await ext.quota(), { windows: [{ id: "weekly", usedPct: 100, resetsAt: null, blocked: true }], error: null });
  ext.workers([]);
  ext.stop();
  assert.deepEqual(seen, [[], "stopped"]);
});

test("herdr env: a named session drops the pane variables inherited from another herdr; null keeps the env", () => {
  const base = { PATH: "/bin", HERDR_SOCKET_PATH: "/u/.config/herdr/herdr.sock", HERDR_PANE_ID: "w1:p1", HERDR_ENV: "1" };
  assert.deepEqual(herdrEnv("paseo-bots", base), { PATH: "/bin", HERDR_SESSION: "paseo-bots" });
  assert.equal(herdrEnv(null, base), base);
  assert.deepEqual(
    parseSessionList('{"sessions":[{"default":true,"name":"default","running":true,"socket_path":"/d.sock"},{"name":"x"}]}').map((s) => s.name),
    ["default"],
  );
});

test("herdr instance: starts its own server once when not running, then hands bots its socket; herdr missing gives null", async () => {
  let running = false;
  const calls: string[] = [];
  const inst = new HerdrInstance("paseo-bots", {
    env: { HERDR_SOCKET_PATH: "/user.sock", PATH: "/bin" },
    run: async (_bin, args, env) => {
      calls.push(`${args.join(" ")} session=${env.HERDR_SESSION} sock=${env.HERDR_SOCKET_PATH ?? "-"}`);
      return JSON.stringify({ sessions: [{ name: "default", running: true, socket_path: "/user.sock" }, ...(running ? [{ name: "paseo-bots", running: true, socket_path: "/b.sock" }] : [])] });
    },
    start: (_bin, env) => {
      calls.push(`start session=${env.HERDR_SESSION}`);
      running = true;
    },
    sleep: async () => {},
  });
  assert.deepEqual(await inst.agentEnv(), { HERDR_SESSION: "paseo-bots", HERDR_SOCKET_PATH: "/b.sock" });
  await inst.ready();
  assert.deepEqual(calls, [
    "session list --json session=paseo-bots sock=-",
    "start session=paseo-bots",
    "session list --json session=paseo-bots sock=-",
  ]);
  const missing = new HerdrInstance("paseo-bots", { run: async () => Promise.reject(new Error("ENOENT")), start: () => {}, sleep: async () => {} });
  assert.equal(await missing.ready(), null);
  assert.deepEqual(await missing.agentEnv(), { HERDR_SESSION: "paseo-bots" });
  const users = new HerdrInstance(null);
  assert.deepEqual(await users.agentEnv(), {});
  assert.equal(await users.ready(), null);
});

test("sign-in options: API keys, Codex, Copilot, OpenRouter, Claude login labelled extra usage; nothing private", async () => {
  const { SIGN_IN_OPTIONS } = await import("../shared/sign-in");
  const providers = new Set(SIGN_IN_OPTIONS.map((o) => o.provider));
  for (const p of ["openai-codex", "github-copilot", "openrouter", "anthropic"]) assert.ok(providers.has(p), p);
  const claude = SIGN_IN_OPTIONS.find((o) => o.method === "paste-code" && o.provider === "anthropic");
  assert.match(claude!.label, /extra usage/i);
  assert.match(claude!.note!, /extra usage/i);
  assert.equal(claude!.badge, "EXTRA USAGE");
  assert.match(claude!.confirm!.title, /EXTRA USAGE/);
  assert.match(claude!.confirm!.body, /not used/);
  // Sam, 27 Oct: sub-par warning and the direct-API subscriptions we recommend instead.
  assert.match(claude!.confirm!.body, /sub-par/);
  for (const alt of ["Codex", "Muse", "Grok", "OpenCode", "GLM", "DeepSeek"]) assert.ok(claude!.confirm!.body.includes(alt), alt);
  // Listed last: every other option comes first.
  assert.equal(SIGN_IN_OPTIONS.at(-1), claude);
  assert.ok(SIGN_IN_OPTIONS.some((o) => o.method === "api-key"));
  // Private provider names are not written in this repo: the same patterns as the installer's
  // tarball guard (DINOBOT_PRIVATE_GUARD, or ~/.config/dinobot/private-guard.txt), when present.
  for (const p of privateGuardPatterns()) assert.doesNotMatch(JSON.stringify(SIGN_IN_OPTIONS), new RegExp(p, "i"));
});

test("group chats: read-only lookups (A) by default; rooms.fullTools true only when exactly true (B)", () => {
  assert.deepEqual(DEFAULT_SETTINGS.rooms, { fullTools: false });
  assert.equal(parseSettings({ rooms: { fullTools: true } }).rooms.fullTools, true);
  for (const rooms of [undefined, null, true, "yes", { fullTools: "true" }, { fullTools: 1 }, {}])
    assert.equal(parseSettings({ rooms }).rooms.fullTools, false, JSON.stringify(rooms));
});

test("group chats: writeRoomFullTools keeps every other key, creates the file when missing, refuses a non-object file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-settings-rooms-"));
  const file = join(dir, ".settings.json");
  assert.deepEqual(writeRoomFullTools(dir, true, {}), { fullTools: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { rooms: { fullTools: true } });
  writeFileSync(file, JSON.stringify({ user: { name: "Sam" }, rooms: { other: 1, fullTools: true }, addons: { x: { y: 2 } } }));
  writeRoomFullTools(dir, false, {});
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { user: { name: "Sam" }, rooms: { other: 1, fullTools: false }, addons: { x: { y: 2 } } });
  assert.equal(readSettings({ PASEO_BOTS_ROOT: dir }).rooms.fullTools, false);
  writeRoomFullTools(dir, true, {});
  assert.equal(readSettings({ PASEO_BOTS_ROOT: dir }).user.name, "Sam");
  assert.equal(readSettings({ PASEO_BOTS_ROOT: dir }).rooms.fullTools, true);
  writeFileSync(file, "[1]");
  assert.throws(() => writeRoomFullTools(dir, true, {}), /not a JSON object/);
  assert.equal(readFileSync(file, "utf8"), "[1]");
  // PASEO_BOTS_SETTINGS wins, as for reads.
  const other = join(dir, "elsewhere.json");
  writeRoomFullTools(dir, true, { PASEO_BOTS_SETTINGS: other });
  assert.deepEqual(JSON.parse(readFileSync(other, "utf8")), { rooms: { fullTools: true } });
});

test("Claude login through a provider plugin: the plugin's own name, plan usage, unofficial, still confirmed", async () => {
  const { claudeViaPlugin } = await import("../shared/sign-in");
  const w = claudeViaPlugin("Acme Bridge");
  assert.equal(w.label, "Claude login (your plan, via Acme Bridge)");
  assert.equal(w.badge, "UNOFFICIAL");
  // Sam, 27 Oct (fr-app Q3).
  assert.equal(w.note, "Uses your Claude plan through Acme Bridge (unofficial; Anthropic's terms risk).");
  assert.match(w.confirm.title, /Acme Bridge/);
  assert.match(w.confirm.body, /included usage, not extra usage/);
  assert.match(w.confirm.body, /terms/);
  assert.doesNotMatch(JSON.stringify(w), /EXTRA USAGE/);
  assert.equal(w.confirm.ok, "Continue with Claude");
  // No plugin is named in the public source; the name only comes from the host at run time.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "sign-in.ts"), "utf8");
  assert.doesNotMatch(source, /pi[-_ ]?black/i);
});

function privateGuardPatterns(): string[] {
  const f = process.env.DINOBOT_PRIVATE_GUARD_FILE ?? join(homedir(), ".config", "dinobot", "private-guard.txt");
  const text = process.env.DINOBOT_PRIVATE_GUARD ?? (existsSync(f) ? readFileSync(f, "utf8") : "");
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
