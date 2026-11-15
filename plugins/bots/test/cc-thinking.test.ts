// A Claude Code bot's thinking in the app: the view mod streams each thinking block of a step to the engine (the
// whole block so far), the engine passes it on, and the provider shows it as a `reasoning` row (one per block, the
// same id as it grows), as pi bots' thinking shows. Thinking Claude Code got none of (summaries off) sends nothing.
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

const TMP = mkdtempSync(join(tmpdir(), "cc-thinking-"));
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
  return { step: hooks.get("turn.step")!, calls, $ };
}

/** Runs the mod's turn.step over a response made of `chunks` (a number waits that many ms); returns what it yielded. */
async function runStep(step: Function, $: unknown, e: object, chunks: Array<object | number>, result: object) {
  async function* next() {
    for (const c of chunks) {
      if (typeof c === "number") await tick(c);
      else yield c;
    }
    return result;
  }
  const gen = step($, { turnId: "T1", index: 0, ...e }, next);
  const out: unknown[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { out, returned: r.value };
    out.push(r.value);
  }
}

describe("view mod: a step's thinking", () => {
  it("goes to the engine before the answer, the whole block each time; chunks pass on unchanged", async () => {
    const { step, calls, $ } = viewMod();
    const chunks = [
      { kind: "engine", ref: 1 },
      { kind: "thinking", index: 0, text: "I'm coun" },
      { kind: "thinking", index: 0, text: "ting." },
      { kind: "text", index: 1, text: "**80**" },
      { kind: "stop", stopReason: "end_turn", usage: null },
    ];
    const result = { answer: "**80**", toolUses: [], stopReason: "end_turn", usage: null };
    const { out, returned } = await runStep(step, $, {}, chunks, result);
    assert.deepEqual(out, chunks);
    assert.equal(returned, result);
    assert.deepEqual(calls, [
      { path: "/event", body: { type: "thinking", block: "T1:0:0", text: "I'm counting." } },
      { path: "/event", body: { type: "step", answer: "**80**" } },
    ]);
  });

  it("streams a long block (at most every 250 ms), then sends it whole when it ends", async () => {
    const { step, calls, $ } = viewMod();
    await runStep(
      step,
      $,
      { index: 2 },
      [{ kind: "thinking", index: 0, text: "a" }, 300, { kind: "thinking", index: 0, text: "b" }, { kind: "thinking", index: 0, text: "c" }, { kind: "tool", index: 1, id: "tu1", name: "Bash" }],
      { answer: "", toolUses: [{ name: "Bash", input: {} }], stopReason: "tool_use", usage: null },
    );
    // A tool-only step: thinking rows, no answer.
    assert.deepEqual(
      calls.map((c) => c.body),
      [
        { type: "thinking", block: "T1:2:0", text: "ab" },
        { type: "thinking", block: "T1:2:0", text: "abc" },
      ],
    );
  });

  it("sends nothing for empty thinking (summaries off: signature only) or a subagent's step", async () => {
    const { step, calls, $ } = viewMod();
    await runStep(step, $, {}, [{ kind: "thinking", index: 0, text: "" }, { kind: "text", index: 1, text: "hi" }], { answer: "hi", toolUses: [], stopReason: "end_turn", usage: null });
    await runStep(step, $, { agentId: "a1" }, [{ kind: "thinking", index: 0, text: "sub" }], { answer: "x", toolUses: [], stopReason: "end_turn", usage: null });
    assert.deepEqual(calls.map((c) => c.body), [{ type: "step", answer: "hi" }]);
  });
});

describe("cc provider: thinking rows", () => {
  it("one reasoning row per block, the same id as it grows, before the answer; none outside a turn", async () => {
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
    await post("/event", { type: "thinking", block: "T0:0:0", text: "before any turn" });
    await post("/turn", { running: true, typed: true, text: "hi", origin: "composer" });
    await post("/event", { type: "thinking", block: "T1:0:0", text: "I'm coun" });
    await post("/event", { type: "thinking", block: "T1:0:0", text: "I'm counting." });
    await post("/event", { type: "thinking", block: "T1:0:1", text: "  \n" });
    await post("/event", { type: "step", answer: "**80**" });
    await post("/event", { type: "thinking", block: "T1:1:0", text: "Next step." });
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [`${e.item.type}|${e.item.id.replace(/^u-t-.*/, "u")}|${(e.item as any).text}`] : []));
    const turn = (events.find((e) => e.type === "session.turn") as any).turnId;
    assert.deepEqual(items, [
      "user_message|u|hi",
      `reasoning|r-${turn}-T1:0:0|I'm coun`,
      `reasoning|r-${turn}-T1:0:0|I'm counting.`,
      `assistant_message|a-${turn}-0|**80**`,
      `reasoning|r-${turn}-T1:1:0|Next step.`,
    ]);
  });
});
