// Context, cost and usage of Claude Code bots (CU1): server/cc/usage.ts, the engine's /usage and /job, the
// provider's session.usage, and the inbox mod's reports.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcEngine, CcHost } from "../server/cc/engine";
import { createCcProvider } from "../server/cc/provider";
import { anthropicPrice, CcUsageLedger, priceOf } from "../server/cc/usage";
// @ts-expect-error the mod is plain JS
import { register as registerInbox } from "../claude-code/inbox/hooks/register.js";

const TMP = mkdtempSync(join(tmpdir(), "cc-usage-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const open: CcEngine[] = [];
after(async () => {
  for (const e of open) await e.close();
});

/** A pi folder whose catalog prices two Anthropic models (figures as pi's models-store.json has them). */
function piDir() {
  const dir = join(TMP, "pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models-store.json"),
    JSON.stringify({
      anthropic: {
        models: [
          { id: "claude-sonnet-5-5", cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
          { id: "claude-haiku-4-5", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
          { id: "claude-haiku-5-5", cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }] } },
        ],
      },
    }),
  );
  return dir;
}

describe("cc usage ledger", () => {
  it("adds what each TUI process grew by to the chat; a relaunch starts at 0 and keeps counting", () => {
    const file = join(TMP, "l1", "usage.json");
    const l = new CcUsageLedger(file);
    assert.equal(l.usage("s1"), null);
    l.run("s1", { run: "a:1", context: { window: 200000, tokens: 50000 }, costUsd: 0.1, tokens: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } });
    const u = l.run("s1", { run: "a:1", context: { window: 200000, tokens: 60000 }, costUsd: 0.25, tokens: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 } });
    assert.deepEqual(u, { inputTokens: 40, cachedInputTokens: 300, outputTokens: 9, totalCostUsd: 0.25, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 60000 });
    // A stale report (lower figures) adds nothing.
    assert.equal(l.run("s1", { run: "a:1", costUsd: 0.2 }).totalCostUsd, 0.25);
    // Relaunch: a new run, its figures from 0; the fill is the local estimate until a response measures it.
    const r = l.run("s1", { run: "b:2", context: { window: 1000000, estimate: 9000 }, costUsd: 0.05 });
    assert.equal(r.totalCostUsd, 0.3);
    assert.equal(r.contextWindowMaxTokens, 1000000);
    assert.equal(r.contextWindowUsedTokens, 9000);
    // A compaction Claude Code does not count.
    assert.equal(l.extra("s1", { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 0.02).totalCostUsd, 0.32);
    // Kept on disk: a restarted daemon goes on from there, and the same run is not counted twice.
    const again = new CcUsageLedger(file);
    assert.equal(again.usage("s1")!.totalCostUsd, 0.32);
    assert.equal(again.run("s1", { run: "b:2", costUsd: 0.05 }).totalCostUsd, 0.32);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 1);
  });

  it("a run's growth goes to the chat that shows it", () => {
    const l = new CcUsageLedger(join(TMP, "l2", "usage.json"));
    l.run("s1", { run: "a", costUsd: 0.1 });
    assert.equal(l.run("s2", { run: "a", costUsd: 0.15 }).totalCostUsd, 0.05);
    assert.equal(l.usage("s1")!.totalCostUsd, 0.1);
  });

  it("no window known: no context figures (the meter says no data rather than a wrong fill)", () => {
    const l = new CcUsageLedger(join(TMP, "l3", "usage.json"));
    const u = l.run("s1", { run: "a", costUsd: 0.01 });
    assert.equal(u.contextWindowMaxTokens, undefined);
    assert.equal(u.contextWindowUsedTokens, undefined);
  });
});

describe("cc compactor prices (pi's catalog)", () => {
  it("prices as Claude Code does: haiku-5-5, 100k in + 1k out = $0.0105 (the probe's figure)", () => {
    const env = { PI_CODING_AGENT_DIR: piDir() };
    const p = anthropicPrice(undefined, "haiku", env)!;
    assert.equal(p.id, "claude-haiku-5-5"); // the family's newest
    assert.equal(priceOf({ input_tokens: 100000, output_tokens: 1000 }, p.price).toFixed(6), "0.010500");
    // Over the tier: the dearer rates.
    assert.equal(priceOf({ input_tokens: 200000 }, p.price).toFixed(6), "0.100000");
    const s = anthropicPrice("claude-sonnet-5-5", "sonnet", env)!;
    assert.equal(priceOf({ input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 }, s.price).toFixed(6), "0.015500");
    assert.equal(anthropicPrice(undefined, "opus", env), null);
    assert.equal(anthropicPrice("claude-x", undefined, { PI_CODING_AGENT_DIR: join(TMP, "none") }), null);
  });
});

describe("cc engine: /usage and the compactor's cost", () => {
  it("passes the TUI's figures on, checked", async () => {
    const e = await CcEngine.open("u1", join(TMP, "u1"));
    open.push(e);
    const seen: any[] = [];
    e.onEvent((ev) => seen.push(ev));
    const r = await e.handle("POST", "/usage", new URLSearchParams(), { run: "x:1", context: { window: 200000, tokens: 1234, junk: 1 }, costUsd: 0.5, tokens: { input_tokens: 3, output_tokens: "9" }, rateLimits: [{ kind: "five_hour", percentUsed: 42, resetsAt: "2026-11-15T12:00:00Z" }, { kind: 7 }] });
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(seen, [
      {
        type: "usage",
        usage: {
          run: "x:1",
          context: { window: 200000, tokens: 1234 },
          costUsd: 0.5,
          tokens: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          rateLimits: [{ kind: "five_hour", percentUsed: 42, resetsAt: "2026-11-15T12:00:00Z" }],
        },
      },
    ]);
    assert.deepEqual((await e.handle("POST", "/usage", new URLSearchParams(), {})).json, { ok: false });
  });

  it("prices each compaction (Claude Code leaves $.model.complete out of its cost) and logs it", async () => {
    const dir = join(TMP, "u2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ compactor: { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" } }));
    const e = await CcEngine.open("u2", dir, { env: { PI_CODING_AGENT_DIR: piDir() } });
    open.push(e);
    const seen: any[] = [];
    e.onEvent((ev) => seen.push(ev));
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 };
    await e.handle("POST", "/job", new URLSearchParams(), { id: "nope", text: "line", usage, model: "sonnet" });
    // A runner that knows its own price says so (e.g. a pi compactor).
    await e.handle("POST", "/job", new URLSearchParams(), { id: "nope", text: "line", usage, model: "gpt", costUsd: 0.003 });
    assert.deepEqual(
      seen.map((x) => [x.type, x.costUsd?.toFixed(6), x.model]),
      [
        ["extra-usage", "0.015500", "claude-sonnet-5-5"],
        ["extra-usage", "0.003000", "gpt"],
      ],
    );
    const log = readFileSync(join(dir, "compactor-usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log[0].pricedAs, "claude-sonnet-5-5");
    assert.equal(log[0].costUsd.toFixed(6), "0.015500");
  });
});

describe("cc provider: session.usage for the app's context meter", () => {
  it("each report becomes the chat's usage: fill, window, cost (compactions on top); a reopened chat shows it again", async () => {
    const root = join(TMP, "bots");
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
    const optchatHome = join(TMP, "oc");
    const prof = join(optchatHome, "profiles", "kit");
    mkdirSync(prof, { recursive: true });
    writeFileSync(join(prof, "config.json"), JSON.stringify({ compactor: { provider: "anthropic", model: "claude-sonnet-5-5" } }));
    const host = new CcHost(join(root, ".cc"));
    // The TUI the engine types into (HD1, deliver.ts): idle, takes every text.
    const typed: string[] = [];
    const tui = { state: async () => "idle", prompt: async (t: string) => (typed.push(t), { ok: true as const }), clear: async () => {}, sessionFile: async () => null };
    const launcher = { ensure: async () => {}, interrupt: async () => {}, restart: async () => {}, running: async () => true, delivery: () => tui };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome, models: async () => [] });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    const openChat = async (sessionId: string) => {
      await conn.send({ type: "session.open", requestId: `r-${sessionId}`, sessionId, history: "skip", config: { cwd: join(root, "kit"), env: { PI_CODING_AGENT_DIR: piDir() }, mcpServers: {}, settings: {}, persist: true } });
      await tick(50);
    };
    await openChat("s1");
    const usages = () => events.flatMap((e) => (e.type === "session.usage" ? [e] : []));
    assert.equal(usages().length, 0); // nothing counted yet: no figures rather than zeros
    const engine = host.engines.get("kit")!;
    // A turn runs; Claude Code measures it.
    await conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "c1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } } });
    for (let i = 0; i < 200 && !typed.length; i++) await tick(10);
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "hi" }); // the mod's ack
    await engine.handle("POST", "/usage", new URLSearchParams(), { run: "cc1:1", context: { window: 200000, tokens: 23000 }, costUsd: 0.4, tokens: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20000, cache_creation_input_tokens: 2900 } });
    await engine.handle("POST", "/job", new URLSearchParams(), { id: "j", text: "x", usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 }, model: "sonnet" });
    await tick(20);
    const [first, second] = usages();
    assert.deepEqual(first, { type: "session.usage", sessionId: "s1", turnId: "c1", usage: { inputTokens: 3000, cachedInputTokens: 20000, outputTokens: 50, totalCostUsd: 0.4, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 23000 } });
    assert.equal(second!.usage.totalCostUsd, 0.4155);
    assert.equal(second!.usage.contextWindowUsedTokens, 23000);
    // The TUI starts again (new model): its figures restart at 0; the chat's keep growing.
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: false, answered: true });
    await engine.handle("POST", "/usage", new URLSearchParams(), { run: "cc2:2", context: { window: 1000000, estimate: 8000 }, costUsd: 0 });
    await tick(20);
    const third = usages().at(-1)!;
    assert.equal(third.turnId, undefined);
    assert.deepEqual([third.usage.totalCostUsd, third.usage.contextWindowMaxTokens, third.usage.contextWindowUsedTokens], [0.4155, 1000000, 8000]);
    // The chat is opened again (app reconnect, daemon restart): its figures come with it.
    await conn.send({ type: "session.close", requestId: "rc", sessionId: "s1" });
    await tick(20);
    events.length = 0;
    await openChat("s1");
    assert.equal(usages()[0]!.usage.totalCostUsd, 0.4155);
    await conn.close();
    await host.close();
  });
});

/** A fake mod runtime (as cc-task-notification.test.ts): every engine call is recorded. */
function fakeMod() {
  const hooks = new Map<string, Function>();
  registerInbox((event: string, fn: Function) => hooks.set(event, fn));
  const calls: Array<{ path: string; body: any }> = [];
  const timers: Array<() => unknown> = [];
  let usage: any = { startedAt: 1, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } };
  const $ = {
    env: { get: async (k: string) => (k === "OPTCHAT_ENGINE_FILE" ? "/engine.json" : "") },
    fs: { read: async () => JSON.stringify({ url: "http://engine/b/kit", token: "t" }), write: async () => {} },
    http: {
      fetch: async (url: string, init: { method: string; body?: string }) => {
        const path = url.replace("http://engine/b/kit", "");
        calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
        return { status: 200, text: JSON.stringify(path === "/hello" ? { inbox: 0 } : { ok: true }) };
      },
    },
    ui: { log: () => {}, status: () => {} },
    clock: { now: async () => 1000, every: () => {}, after: (_ms: number, fn: () => unknown) => void timers.push(fn) },
    session: {
      id: async () => "sess",
      usage: async (args?: { breakdown?: string }) => (args?.breakdown ? { ...usage, context: { ...usage.context, breakdown: { totalTokens: 7000 } } } : usage),
    },
  };
  return { hooks, calls, $, timers, setUsage: (u: any) => (usage = u) };
}

describe("inbox mod: Claude Code's figures to the engine", () => {
  it("at start (an estimate), after each measured turn, after a compaction; tokens of every loop's turns", async () => {
    const { hooks, calls, $, timers, setUsage } = fakeMod();
    const next = async (e: unknown) => e;
    await hooks.get("session.start")!($, {}, next);
    await tick();
    const posted = () => calls.filter((c) => c.path === "/usage").map((c) => c.body);
    assert.deepEqual(posted(), [
      { run: "sess:1000", context: { window: 200000, estimate: 7000 }, costUsd: 0, tokens: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, rateLimits: [] },
    ]);
    // A turn (and a subagent's) ends; Claude Code measures.
    await hooks.get("turn.complete")!($, { agentId: "sub1", reason: "answer", usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" } }, next);
    await hooks.get("turn.complete")!($, { reason: "answer", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, model: "m" } }, next);
    const measured = { context: { window: 200000, tokens: 23000, percent: 12 }, rateLimits: [{ kind: "five_hour", percentUsed: 3 }], cost: { usd: 0.42 }, changed: ["context", "cost"] };
    await hooks.get("session.measure")!($, measured, next);
    await tick();
    assert.deepEqual(posted().at(-1), {
      run: "sess:1000",
      context: { window: 200000, tokens: 23000 },
      costUsd: 0.42,
      tokens: { input_tokens: 15, output_tokens: 27, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
      rateLimits: [{ kind: "five_hour", percentUsed: 3 }],
    });
    // The view mod's compaction: counted a moment later, locally.
    setUsage({ startedAt: 1, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.42 } });
    await hooks.get("session.compact")!($, { trigger: "plugin", messages: [] }, next);
    assert.equal(timers.length, 1);
    await timers[0]!();
    assert.deepEqual(posted().at(-1).context, { window: 200000, estimate: 7000 });
  });
});

describe("cc-status.mjs: a Claude Code worker's (and bot's) spend in its status line", () => {
  const script = join(__dirname, "..", "skills", "workers", "cc-status.mjs");
  const status = (dir: string, s: object) => {
    const r = spawnSync(process.execPath, [script, dir], { input: JSON.stringify(s), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  it("keeps each process's highest figure: a late, lower figure is no restart; a resume adds a run", () => {
    const dir = join(TMP, "w1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "budget"), "5\n");
    const model = { display_name: "Haiku" };
    assert.equal(status(dir, { session_id: "a", cost: { total_cost_usd: 0.1, total_duration_ms: 10_000 }, model }), "$0.10 / budget $5.00 · Haiku");
    assert.equal(status(dir, { session_id: "a", cost: { total_cost_usd: 0.3, total_duration_ms: 10_100 }, model }), "$0.30 / budget $5.00 · Haiku");
    // A status line that ran late with the older figure: no banking (the old code counted $0.40 here).
    assert.equal(status(dir, { session_id: "a", cost: { total_cost_usd: 0.1, total_duration_ms: 10_000 }, model }), "$0.30 / budget $5.00 · Haiku");
    // Resumed: the same session in a new process, its figure from 0.
    assert.equal(status(dir, { session_id: "a", cost: { total_cost_usd: 0.05, total_duration_ms: 1_000 }, model }), "$0.35 / budget $5.00 · Haiku");
  });
  it("reads a cost.json from before runs without losing or doubling its figure", () => {
    const dir = join(TMP, "w2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cost.json"), JSON.stringify({ base: 0.4, last: 0.2, session: "b" }));
    assert.equal(status(dir, { session_id: "b", cost: { total_cost_usd: 0.25, total_duration_ms: 50_000 } }), "$0.65");
    const dir2 = join(TMP, "w3");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "cost.json"), JSON.stringify({ base: 0.4, last: 0.2, session: "old" }));
    assert.equal(status(dir2, { session_id: "new", cost: { total_cost_usd: 0.01, total_duration_ms: 5_000 } }), "$0.61");
  });
});
