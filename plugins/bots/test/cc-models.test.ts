// The Claude Code bots' model list (server/cc/models.ts) and how the provider offers it and applies a pick.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { ANTHROPIC_API, CC_ALIASES, CcModels, fetchModels, modelSource, pickerModels, withModel } from "../server/cc/models";
import { createCcProvider, firstProxiedBot } from "../server/cc/provider";

const TMP = mkdtempSync(join(tmpdir(), "cc-models-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const SECRET = "sk-ant-oat01-SECRET";

/** A Models API: `pages` in order (after_id walks them), each a list of [id, display_name, created_at]. */
function api(pages: Array<Array<[string, string, string]>>, calls: Array<{ url: string; headers: Record<string, string> }> = []) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const after = new URL(url).searchParams.get("after_id");
    const i = after ? pages.findIndex((p) => p.at(-1)![0] === after) + 1 : 0;
    const page = pages[i]!;
    const data = page.map(([id, display_name, created_at]) => ({ type: "model", id, display_name, created_at }));
    return { ok: true, status: 200, json: async () => ({ data, has_more: i < pages.length - 1, first_id: page[0]![0], last_id: page.at(-1)![0] }) };
  };
}

function botDir(name: string, meta: object | null) {
  const root = join(TMP, `bots-${name}`);
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, ".optchat-profile"), `${name}\n`);
  if (meta) writeFileSync(join(root, name, ".bot.json"), JSON.stringify(meta));
  return { root, cwd: join(root, name) };
}

describe("cc models: the source", () => {
  it("a bot's proxy (its .bot.json, else DINOBOT_CC_BASE_URL) with its token", () => {
    const { cwd } = botDir("ada", { cc: { baseUrl: "http://gw:8080/team/", authToken: "tok" } });
    const s = modelSource(cwd, {})!;
    assert.equal(s.baseUrl, "http://gw:8080/team");
    assert.equal(s.key, "http://gw:8080/team");
    assert.equal(s.headers.authorization, "Bearer tok");
    assert.equal(modelSource(undefined, { DINOBOT_CC_BASE_URL: "http://gw:9/x" })!.headers["x-api-key"], "proxy");
  });

  it("no proxy: the Claude login's OAuth token, with the OAuth beta; none when it has expired; the key never holds it", () => {
    const dir = join(TMP, "claude-config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: 2_000 } }));
    const s = modelSource(undefined, { DINOBOT_CLAUDE_CONFIG_DIR: dir }, 1_000)!;
    assert.equal(s.baseUrl, ANTHROPIC_API);
    assert.equal(s.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(s.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.doesNotMatch(s.key, /SECRET/);
    assert.equal(modelSource(undefined, { DINOBOT_CLAUDE_CONFIG_DIR: dir }, 3_000), null);
    assert.equal(modelSource(undefined, { DINOBOT_CLAUDE_CONFIG_DIR: join(TMP, "none") }), null);
  });
});

describe("cc models: the list", () => {
  it("walks every page; aliases first, then full ids newest first with their display names", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = api(
      [
        [
          ["claude-opus-5-5", "Claude Opus 5.5", "2026-09-21T16:24:00Z"],
          ["claude-fable-5-2", "Claude Fable 5.2", "2026-11-09T18:30:00Z"],
        ],
        [["claude-haiku-4-5-20251001", "Claude Haiku 4.5", "2025-10-15T00:00:00Z"]],
      ],
      calls,
    );
    const got = await fetchModels({ key: "k", baseUrl: "http://gw/x", headers: { "x-api-key": "proxy" } }, fetchFn);
    assert.deepEqual(got.map((m) => m.id), ["claude-fable-5-2", "claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /^http:\/\/gw\/x\/v1\/models\?limit=100$/);
    assert.match(calls[1]!.url, /after_id=claude-fable-5-2/);
    const list = pickerModels(got);
    assert.deepEqual(list.slice(0, CC_ALIASES.length).map((m) => m.id), ["opus", "sonnet", "haiku", "fable"]);
    assert.deepEqual(list.slice(CC_ALIASES.length).map((m) => `${m.id}=${m.label}`), [
      "claude-fable-5-2=Claude Fable 5.2",
      "claude-opus-5-5=Claude Opus 5.5",
      "claude-haiku-4-5-20251001=Claude Haiku 4.5",
    ]);
    assert.deepEqual(withModel(CC_ALIASES, "claude-opus-4-1").at(-1), { id: "claude-opus-4-1", label: "claude-opus-4-1", description: "claude-opus-4-1" });
    assert.equal(withModel(list, "claude-opus-5-5").length, list.length);
  });

  it("cached an hour per source", async () => {
    const { cwd } = botDir("bo", { cc: { baseUrl: "http://gw/one" } });
    let now = 0;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const m = new CcModels({ fetch: api([[["claude-x-1", "X 1", "2026-01-01T00:00:00Z"]]], calls), now: () => now });
    const [a, b] = await Promise.all([m.list(cwd, {}), m.list(cwd, {})]);
    assert.equal(a.at(-1)!.id, "claude-x-1");
    assert.equal(b, a);
    now = 59 * 60_000;
    await m.list(cwd, {});
    assert.equal(calls.length, 1);
    await m.list(undefined, { DINOBOT_CC_BASE_URL: "http://gw/two" });
    assert.equal(calls.length, 2);
    now = 61 * 60_000;
    await m.list(cwd, {});
    assert.equal(calls.length, 3);
  });

  it("a failing source gives the aliases, logged once and without the token", async () => {
    const dir = join(TMP, "claude-config-2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
    const warned: string[] = [];
    let now = 0;
    const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const m = new CcModels({ fetch: fetchFn, warn: (s) => warned.push(s), now: () => now });
    const env = { DINOBOT_CLAUDE_CONFIG_DIR: dir };
    assert.deepEqual((await m.list(undefined, env)).map((x) => x.id), CC_ALIASES.map((x) => x.id));
    now = 10 * 60_000;
    await m.list(undefined, env);
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /HTTP 401.*aliases only/);
    assert.doesNotMatch(warned.join("\n"), /SECRET/);
    // No source at all: the aliases, logged once.
    const m2 = new CcModels({ warn: (s) => warned.push(s) });
    await m2.list(undefined, { DINOBOT_CLAUDE_CONFIG_DIR: join(TMP, "none") });
    await m2.list(undefined, { DINOBOT_CLAUDE_CONFIG_DIR: join(TMP, "none") });
    assert.equal(warned.length, 2);
  });
});

describe("cc provider: models", () => {
  it("asked for no bot, the list comes from the first bot with a proxy", () => {
    const root = join(TMP, "bots-many");
    for (const [name, meta] of [["a", { name: "A" }], ["c", { cc: { baseUrl: "http://gw/c" } }], ["b", { cc: { baseUrl: "http://gw/b" } }]] as const) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, ".bot.json"), JSON.stringify(meta));
    }
    assert.equal(firstProxiedBot(root), join(root, "b"));
    assert.equal(firstProxiedBot(join(TMP, "nowhere")), undefined);
  });

  it("offers the live list in the catalog and the session; a picked model applies from the next step, with no restart", async () => {
    const { root, cwd } = botDir("kit", { cc: { baseUrl: "http://gw/kit" } });
    const host = new CcHost(join(root, ".cc"));
    const launched: string[] = [];
    const launcher = {
      ensure: async (bot: string, o: { model?: string }) => void launched.push(`ensure ${bot} ${o.model ?? "-"}`),
      interrupt: async () => {},
      running: async () => true,
      // The engine types into the TUI (server/cc/deliver.ts): here always idle, typing accepted.
      delivery: () => ({ state: async () => "idle", sessionFile: async () => null, clear: async () => {}, prompt: async () => ({ ok: true as const }) }),
    };
    const asked: Array<string | undefined> = [];
    const models = async (c: string | undefined) => {
      asked.push(c);
      return [...CC_ALIASES, { id: "claude-fable-5-2", label: "Claude Fable 5.2" }];
    };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, "oc"), models });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence", "session.configure"] });
    assert.ok(conn.capabilities.includes("session.configure"));
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "catalog", requestId: "c1", cwd });
    await conn.send({ type: "catalog", requestId: "c2", cwd: "/not/a/bot" });
    await tick();
    const cats = events.filter((e) => e.type === "catalog") as Array<Extract<ProviderEvent, { type: "catalog" }>>;
    assert.deepEqual(cats[0]!.catalog.models.map((m) => m.id), ["opus", "sonnet", "haiku", "fable", "claude-fable-5-2"]);
    assert.equal(asked[0], cwd);
    assert.equal(asked.length, 2); // not a bot: the daemon's own source, else the first bot with a proxy (this one)

    // An older full id the list lacks stays in the session's list.
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true, model: "claude-opus-4-1", thinkingOption: "medium" } });
    await tick(50);
    const cfg = events.find((e) => e.type === "session.config") as Extract<ProviderEvent, { type: "session.config" }>;
    assert.equal(cfg.config.model, "claude-opus-4-1");
    assert.equal(cfg.config.models!.at(-1)!.id, "claude-opus-4-1");
    assert.deepEqual(launched, ["ensure kit claude-opus-4-1"]);

    // The TUI's model per step (the inbox mod's turn.step hook asks /run): the session's, at once, no restart.
    const engine = host.engines.get("kit")!;
    const run = async () => (await engine.handle("GET", "/run", new URLSearchParams(), {})).json;
    assert.deepEqual(await run(), { model: "claude-opus-4-1", effort: "medium" });
    await conn.send({ type: "session.configure", requestId: "r2", sessionId: "s1", changes: { model: "claude-fable-5-2" } });
    await tick();
    assert.ok(events.some((e) => e.type === "request.completed" && e.requestId === "r2"));
    assert.deepEqual(await run(), { model: "claude-fable-5-2", effort: "medium" });

    // Mid-turn: the turn's next step runs on it (as a pi bot's setModel).
    await conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "t1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } } });
    await tick(50);
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "hi", origin: "composer" });
    await conn.send({ type: "session.configure", requestId: "r3", sessionId: "s1", changes: { model: "opus", thinkingOption: "high" } });
    await tick();
    assert.deepEqual(await run(), { model: "opus", effort: "high" });
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: false, answered: true });
    await tick();
    // Never restarted: a send only makes sure the TUI runs (a TUI not running starts on the session's model).
    assert.deepEqual(launched, ["ensure kit claude-opus-4-1", "ensure kit claude-fable-5-2"]);
    await conn.close();
    await host.close();
  });
});

// Bug: a snapshot built while a bot had no proxy (or its list failed) kept the aliases, without effort, for good.
describe("cc models: a stale list is rebuilt", () => {
  it("the aliases offered when no list can be had keep Claude Code's effort levels", async () => {
    const m = new CcModels({ fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
    const { cwd } = botDir("eff", { cc: { baseUrl: "http://gw/eff" } });
    for (const list of [await m.list(cwd, {}), await new CcModels().list(undefined, { DINOBOT_CLAUDE_CONFIG_DIR: join(TMP, "none") })]) {
      assert.deepEqual(list.map((x) => x.id), CC_ALIASES.map((x) => x.id));
      for (const x of list) assert.deepEqual(x.thinkingOptions?.map((o) => o.id), ["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("catalogKey names the source and fetch: it changes with the bot's proxy, an aliases retry and a fresh list", async () => {
    const { cwd } = botDir("keyed", { cc: { baseUrl: "http://gw/a" } });
    let now = 1_000;
    let ok = false;
    const good = api([[["claude-opus-5-5", "Claude Opus 5.5", "2026-09-21T16:24:00Z"]]]);
    const fetchFn = async (url: string, init: { headers: Record<string, string> }) => (ok ? good(url, init) : { ok: false, status: 503, json: async () => ({}) });
    const m = new CcModels({ fetch: fetchFn, now: () => now, retryMs: 60_000 });
    const k0 = m.catalogKey(cwd, {}); // nothing cached: a fetch starts
    assert.match(k0, /^http:\/\/gw\/a pending@/);
    await tick();
    const k1 = m.catalogKey(cwd, {});
    assert.match(k1, /aliases@/);
    assert.notEqual(k1, k0);
    now += 30_000;
    assert.equal(m.catalogKey(cwd, {}), k1, "stable while the aliases are fresh");
    // The proxy works again: once the retry is due the key moves on, and the next list is the live one.
    ok = true;
    now += 31_000;
    assert.notEqual(m.catalogKey(cwd, {}), k1);
    await tick();
    const k2 = m.catalogKey(cwd, {});
    assert.match(k2, /live@/);
    const list = await m.list(cwd, {});
    assert.ok(list.some((x) => x.id === "claude-opus-5-5"));
    // .bot.json names another proxy: another source, another key.
    writeFileSync(join(cwd, ".bot.json"), JSON.stringify({ cc: { baseUrl: "http://gw/b" } }));
    assert.match(m.catalogKey(cwd, {}), /^http:\/\/gw\/b /);
  });

  it("the provider gives the daemon a catalogue key per bot folder that follows .bot.json cc and chat", async () => {
    // An unreachable proxy: the list fails fast, so the key settles on aliases.
    const { root, cwd } = botDir("prov", { cc: { baseUrl: "http://127.0.0.1:9/x" }, chat: { provider: "optchat-cc/claude-opus-5-5" } });
    const provider = createCcProvider({ host: new CcHost(join(root, ".cc")), launcher: {} as any, botsRoot: root, optchatHome: join(TMP, "oc") });
    assert.equal(typeof provider.getCatalogCacheKey, "function");
    const key = () => provider.getCatalogCacheKey!({ scope: "workspace", cwd });
    const a = await key();
    assert.ok(a?.startsWith(`${cwd} optchat-cc/claude-opus-5-5 http://127.0.0.1:9/x `));
    writeFileSync(join(cwd, ".bot.json"), JSON.stringify({ cc: { baseUrl: "http://127.0.0.1:9/y" }, chat: { provider: "optchat-cc/claude-opus-5-5" } }));
    assert.ok((await key())?.includes("http://127.0.0.1:9/y"));
    writeFileSync(join(cwd, ".bot.json"), JSON.stringify({ cc: { baseUrl: "http://127.0.0.1:9/y" }, chat: { provider: "pi/x" } }));
    assert.ok((await key())?.includes(" pi/x "));
  });
});
