// A Claude Code bot's answer streams into the app as it is written (M1), as pi bots' text_delta does: the view mod
// posts the step's answer so far (at most every 250 ms, `partial`), then the whole answer when the step ends; the
// provider shows each as the same assistant_message row, grown, so Paseo shows only what is new.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { createCcProvider } from "../server/cc/provider";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerView } from "../claude-code/view/hooks/register.js";

const TMP = mkdtempSync(join(tmpdir(), "cc-answer-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanup) await c().catch(() => {});
});

function viewMod() {
  const hooks = new Map<string, Function>();
  registerView((event: string, fn: Function) => hooks.set(event, fn));
  const calls: Array<{ path: string; body: any }> = [];
  const $ = {
    env: { get: async (k: string) => (k === "OPTCHAT_ENGINE_FILE" ? "/engine.json" : "") },
    fs: { read: async () => JSON.stringify({ url: "http://engine/b/kit", token: "t" }), write: async () => {} },
    http: {
      fetch: async (url: string, init: { method: string; body?: string }) => {
        calls.push({ path: url.replace("http://engine/b/kit", ""), body: init.body ? JSON.parse(init.body) : undefined });
        return { status: 200, text: "{}" };
      },
    },
    ui: { log: () => {}, status: () => {} },
  };
  return { step: hooks.get("turn.step")!, toolCall: hooks.get("tool.call")!, calls, $ };
}

async function runStep(step: Function, $: unknown, chunks: Array<object | number>, result: object) {
  async function* next() {
    for (const c of chunks) {
      if (typeof c === "number") await tick(c);
      else yield c;
    }
    return result;
  }
  const gen = step($, { turnId: "T1", index: 0 }, next);
  for (;;) if ((await gen.next()).done) return;
}

describe("view mod: a step's answer", () => {
  it("streams the answer so far (at most every 250 ms), then the whole answer", async () => {
    const { step, calls, $ } = viewMod();
    await runStep(
      step,
      $,
      [{ kind: "text", index: 0, text: "Hel" }, 300, { kind: "text", index: 0, text: "lo, " }, { kind: "text", index: 0, text: "world" }, { kind: "stop", stopReason: "end_turn", usage: null }],
      { answer: "Hello, world", toolUses: [], stopReason: "end_turn", usage: null },
    );
    assert.deepEqual(
      calls.map((c) => c.body),
      [
        { type: "step", answer: "Hello,", partial: true },
        { type: "step", answer: "Hello, world" },
      ],
    );
  });

  it("stops streaming at a second text block (Claude Code joins them): the whole answer still goes", async () => {
    const { step, calls, $ } = viewMod();
    await runStep(
      step,
      $,
      [{ kind: "text", index: 0, text: "One" }, 300, { kind: "text", index: 0, text: "." }, { kind: "text", index: 2, text: "Two" }, 300, { kind: "text", index: 2, text: "." }],
      { answer: "One.\n\nTwo.", toolUses: [], stopReason: "end_turn", usage: null },
    );
    assert.deepEqual(
      calls.map((c) => c.body),
      [
        { type: "step", answer: "One.", partial: true },
        { type: "step", answer: "One.\n\nTwo." },
      ],
    );
  });
});

// ST1, recorded from a real turn (19 Nov): the step's text block "Partly. The two workers ..." streamed as "Part" (sent
// at once, the thinking having taken over 250 ms) and the rest within 250 ms, then the model began a Bash call, which
// Claude Code ran before the step ended. The app showed "Part", the Shell row, then "ly. The two workers ...".
const SPLIT_TEXT = "Partly. The two workers that have finished worked off `next` but haven't been merged into it.";
const splitChunks = (toolCall: () => void): Array<object | number | (() => void)> => [
  { kind: "thinking", index: 0, text: "Check what is merged." },
  300,
  { kind: "text", index: 1, text: "Part" },
  { kind: "text", index: 1, text: "ly. The two workers that have finished worked off `next`" },
  { kind: "text", index: 1, text: " but haven't been merged into it." },
  { kind: "tool", index: 2, id: "toolu_1", name: "Bash" },
  { kind: "input", index: 2, json: '{"command":"git log -1"}' },
  // The block is whole: Claude Code runs the call while the step goes on.
  toolCall,
  { kind: "stop", stopReason: "tool_use", usage: null },
];
const splitResult = { answer: SPLIT_TEXT, toolUses: [{ tool: "Bash", input: { command: "git log -1" }, tool_use_id: "toolu_1" }], stopReason: "tool_use", usage: null };

async function runSplitStep(mod: ReturnType<typeof viewMod>) {
  let call: Promise<unknown> | undefined;
  async function* next() {
    for (const c of splitChunks(() => {
      call = mod.toolCall(mod.$, { tool: "Bash", tool_use_id: "toolu_1", command: "git log -1", run_in_background: true }, async () => ({ text: "abc123" }));
    })) {
      if (typeof c === "number") await tick(c);
      else if (typeof c === "function") c();
      else yield c;
    }
    return splitResult;
  }
  const gen = mod.step(mod.$, { turnId: "T1", index: 0 }, next);
  for (;;) if ((await gen.next()).done) break;
  await call;
}

describe("view mod: a step's text before a tool call (ST1)", () => {
  it("sends the whole text block before the tool's row", async () => {
    const mod = viewMod();
    await runSplitStep(mod);
    const bodies = mod.calls.map((c) => c.body);
    const running = bodies.findIndex((b) => b.type === "tool" && b.phase === "running");
    assert.ok(running > 0);
    const before = bodies.slice(0, running).filter((b) => b.type === "step");
    assert.equal(before.at(-1)?.answer, SPLIT_TEXT, `text sent before the tool row: ${JSON.stringify(before)}`);
  });
});

describe("cc provider: a streamed answer", () => {
  it("is one assistant_message row per step, the same id as it grows", async () => {
    const root = join(TMP, "p1");
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
    const host = new CcHost(join(root, ".cc"));
    const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, "oc") });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    cleanup.push(async () => {
      await conn.close();
      await host.close();
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const engine = host.engines.get("kit")!;
    const post = (path: string, body: unknown) => engine.handle("POST", path, new URLSearchParams(), body);
    await post("/turn", { running: true, typed: true, text: "hi", origin: "composer" });
    await post("/event", { type: "step", answer: "Hel", partial: true });
    await post("/event", { type: "step", answer: "Hello", partial: true });
    await post("/event", { type: "step", answer: "Hello, world" });
    await post("/event", { type: "step", answer: "Next", partial: true });
    await post("/event", { type: "step", answer: "Next step." });
    const turn = (events.find((e) => e.type === "session.turn") as any).turnId;
    const items = events.flatMap((e) => (e.type === "timeline.item" && e.item.type === "assistant_message" ? [`${e.item.id}|${e.item.text}`] : []));
    assert.deepEqual(items, [`a-${turn}-0|Hel`, `a-${turn}-0|Hello`, `a-${turn}-0|Hello, world`, `a-${turn}-1|Next`, `a-${turn}-1|Next step.`]);
  });

  it("keeps a text block whole and before the tool call that followed it (ST1)", async () => {
    const root = join(TMP, "p2");
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
    const host = new CcHost(join(root, ".cc"));
    const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, "oc2") });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    cleanup.push(async () => {
      await conn.close();
      await host.close();
    });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const engine = host.engines.get("kit")!;
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "are we on the new versioning?", origin: "composer" });
    // The view mod's posts go to the engine, in the order it sends them.
    const mod = viewMod();
    mod.$.http.fetch = async (url: string, init: { method: string; body?: string }) => {
      const r = await engine.handle(init.method, url.replace("http://engine/b/kit", ""), new URLSearchParams(), init.body ? JSON.parse(init.body) : undefined);
      return { status: 200, text: JSON.stringify((r as any)?.json ?? {}) };
    };
    await runSplitStep(mod);
    // What the app shows: Paseo sends a row's growth as the new text only (plugin-provider mapTimelineItem), and the
    // app adds it to the last row if that is the same message, else starts a row (stream.ts appendAssistantMessage).
    const seen = new Map<string, string>();
    const rows: string[] = [];
    let lastId: string | null = null;
    for (const e of events) {
      if (e.type !== "timeline.item") continue;
      const it = e.item as any;
      if (it.type === "assistant_message") {
        const prev = seen.get(it.id) ?? "";
        seen.set(it.id, it.text);
        const delta = it.text.startsWith(prev) ? it.text.slice(prev.length) : it.text;
        if (!delta) continue;
        if (lastId === it.id) rows[rows.length - 1] += delta;
        else rows.push(`text:${delta}`);
        lastId = it.id;
      } else if (it.type === "tool_call") {
        if (rows.at(-1) !== `tool:${it.name}`) rows.push(`tool:${it.name}`);
        lastId = null;
      }
    }
    assert.deepEqual(rows, [`text:${SPLIT_TEXT}`, "tool:Bash"]);
  });
});
