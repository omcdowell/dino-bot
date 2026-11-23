// Session list, rewind and the OptChat profile tools (/optchat) for Claude Code bots, through the app's paths as for
// pi bots (cc-parity review L7, L11).
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { backgroundState, memoryDirectory, runBackground, startBackground } from "pi-optchat/api";
import { CcHost } from "../server/cc/engine";
import { createCcProvider } from "../server/cc/provider";
import { addHidden, rewindRange } from "../server/cc/sessions";

const TMP = mkdtempSync(join(tmpdir(), "cc-sess-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanup) await c().catch(() => {});
});

function bot(root: string, name: string, chat: string | null) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, ".optchat-profile"), `${name}\n`);
  if (chat) writeFileSync(join(root, name, ".bot.json"), JSON.stringify({ chat: { provider: chat } }));
}

async function setup(name: string) {
  const root = join(TMP, name);
  bot(root, "kit", "optchat-cc/opus");
  bot(root, "pip", "optchat/anthropic/claude-sonnet-5-5");
  const host = new CcHost(join(root, ".cc"));
  const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
  const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(root, "oc"), models: async () => [] });
  const conn = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.command", "session.persistence", "session.list", "session.revert.conversation", "permission"],
  });
  cleanup.push(async () => {
    await conn.close();
    await host.close();
  });
  const events: ProviderEvent[] = [];
  conn.onEvent((e) => events.push(e));
  const until = async (pred: () => unknown) => {
    for (let k = 0; k < 100 && !pred(); k++) await tick();
    assert.ok(pred(), JSON.stringify(events.slice(-5)));
  };
  const open = async (sessionId: string, extra: Record<string, unknown> = {}) => {
    await conn.send({ type: "session.open", requestId: `o-${sessionId}`, sessionId, history: "replay", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true }, ...extra } as any);
    await until(() => events.some((e) => e.type === "session.ready" && e.sessionId === sessionId));
  };
  const request = async (input: any) => {
    await conn.send(input);
    await until(() => events.some((e) => (e.type === "request.completed" || e.type === "request.failed" || e.type === "sessions") && (e as any).requestId === input.requestId));
    return events.find((e) => (e as any).requestId === input.requestId && e.type !== "session.opened") as any;
  };
  return { root, host, conn, events, open, request, until };
}

describe("cc provider: session list", () => {
  it("lists Claude Code bots with their last message, filtered by folder; pi bots are pi's", async () => {
    const { root, conn, request } = await setup("list");
    assert.ok(conn.capabilities.includes("session.list"));
    // The bot's log, as its engine writes it (no engine open).
    const main = join(root, "oc", "profiles", "kit", "main");
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, "2026-11-18.jsonl"), [{ i: 0, kind: "user", text: "hi", size: 2, date: "2026-11-18T01:00:00Z" }, { i: 1, kind: "talk", text: "Hello\nthere", size: 5, date: "2026-11-18T01:00:01Z" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const all = await request({ type: "sessions", requestId: "q1" });
    assert.deepEqual(all.sessions, [{ persistence: { version: 1, data: { bot: "kit" } }, cwd: join(root, "kit"), title: "kit", description: "Hello there", updatedAt: "2026-11-18T01:00:01Z" }]);
    assert.equal((await request({ type: "sessions", requestId: "q2", cwd: join(root, "pip") })).sessions.length, 0);
    assert.equal((await request({ type: "sessions", requestId: "q3", query: "nothing like it" })).sessions.length, 0);
  });
});

describe("cc provider: rewind", () => {
  it("rewinds to a message: hidden from the reopened chat's history, kept in the bot's memory", async () => {
    const { host, conn, events, open, request } = await setup("rewind");
    assert.ok(conn.capabilities.includes("session.revert.conversation"));
    await open("s1");
    const engine = host.engines.get("kit")!;
    engine.memory.append("user", "first", undefined, "t1");
    engine.memory.append("talk", "one");
    engine.memory.append("user", "second", undefined, "t2");
    engine.memory.append("talk", "two");
    // A message sent in this chat carries the token Paseo hands back on rewind.
    await conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "t3", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "third" }] } } } as any);
    await tick();
    const sent = events.find((e) => e.type === "timeline.item" && (e.item as any).id === "u-t3") as any;
    assert.deepEqual(sent.item.revertToken, { turn: "t3" });

    // While that turn waits, rewinding is refused, as on pi.
    const busy = await request({ type: "session.revert", requestId: "rv0", sessionId: "s1", token: { turn: "t2" }, scope: "conversation" });
    assert.equal(busy.type, "request.failed");
    await request({ type: "session.interrupt", requestId: "int", sessionId: "s1" });

    const done = await request({ type: "session.revert", requestId: "rv1", sessionId: "s1", token: { turn: "t2" }, scope: "conversation" });
    assert.equal(done.type, "request.completed", JSON.stringify(done));
    const persisted = events.filter((e) => e.type === "session.persistence").at(-1) as any;
    assert.deepEqual(persisted.persistence, { version: 1, data: { bot: "kit", hidden: [[2, 4]] } });
    assert.equal(engine.memory.root.length, 4, "the bot's memory keeps the rewound messages");

    // Reopened (a daemon restart, an import): the history stops before the rewound message; later ones show.
    engine.memory.append("user", "after the rewind", undefined, "t4");
    const from = events.length;
    await open("s2", { persistence: persisted.persistence });
    const replay = events.slice(from).filter((e) => e.type === "timeline.item" && e.sessionId === "s2") as any[];
    assert.deepEqual(replay.map((e) => e.item.text), ["first", "one", "after the rewind"]);
    assert.deepEqual(replay[0].item.revertToken, { i: 0 });
    const opened = events.find((e) => e.type === "session.opened" && e.sessionId === "s2") as any;
    assert.deepEqual(opened.persistence.data.hidden, [[2, 4]]);
  });

  it("a message not in the log yet cannot be rewound to; ranges merge", () => {
    assert.throws(() => rewindRange({ turn: "x" }, [{ i: 0, kind: "user", receipt: "y" }]), /not reached the bot/);
    assert.deepEqual(rewindRange({ i: 1 }, [{ i: 0, kind: "talk" }, { i: 1, kind: "user" }, { i: 2, kind: "talk" }]), [1, 3]);
    assert.deepEqual(addHidden([[2, 4]], [3, 6]), [[2, 6]]);
    assert.deepEqual(addHidden([[2, 4]], [6, 8]), [[2, 4], [6, 8]]);
  });
});

describe("cc provider: /optchat profile tools", () => {
  const command = async (s: Awaited<ReturnType<typeof setup>>, id: string, args: string) => {
    await s.conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: id, delivery: "auto", input: { type: "command", name: "optchat", arguments: args } } } as any);
    await s.until(() => s.events.some((e) => e.type === "session.prompt_result" && e.clientMessageId === id));
    const note = s.events.find((e) => e.type === "timeline.item" && (e.item as any).id === `cmd-${id}`) as any;
    return note?.item;
  };

  it("offers /optchat; browse writes the memory browser; usage and settings answer in the chat", async () => {
    const s = await setup("tools");
    await s.open("s1");
    const commands = s.events.find((e) => e.type === "session.commands") as any;
    assert.ok(commands.commands.some((c: any) => c.name === "optchat"));
    const browse = await command(s, "c1", "browse");
    const file = /written: (\S+)/.exec(browse.message)?.[1];
    assert.ok(file && existsSync(file) && readFileSync(file, "utf8").includes("<html"), browse.message);
    assert.match((await command(s, "c2", "usage")).message, /This chat: nothing counted yet/);
    assert.match((await command(s, "c3", "settings")).message, /Edit/);
    const bad = await command(s, "c4", "nope");
    assert.equal(bad.level, "error");
  });

  it("finishes a built background import: the bot's engine reopens on the imported memory", async () => {
    const s = await setup("import");
    await s.open("s1");
    const dir = join(s.root, "oc", "profiles", "kit");
    const before = s.host.engines.get("kit")!;
    before.memory.append("user", "live hello", undefined, "t1");
    startBackground(dir, [
      { kind: "user", text: "old question", date: "2026-01-01T00:00:00Z", receipt: "import:c1:m1", origin: { source: "claude", conversation: "c1", message: "m1", title: "old" } },
      { kind: "talk", text: "old answer", date: "2026-01-01T00:00:01Z", receipt: "import:c1:m2", origin: { source: "claude", conversation: "c1", message: "m2", title: "old" } },
    ] as any);
    assert.equal((await runBackground(dir, async (input) => `s:${input.source.length}`, new AbortController().signal)).status, "ready");
    assert.match((await command(s, "c1", "import")).message, /import finish/);
    const finished = await command(s, "c2", "import finish");
    assert.match(finished.message, /Imported 2 messages/, finished.message);
    assert.equal(backgroundState(dir), undefined);
    const after = s.host.engines.get("kit")!;
    assert.notEqual(after, before);
    assert.equal(after.memory.directory, memoryDirectory(dir));
    assert.deepEqual(after.memory.root.map((e) => e.text), ["old question", "old answer", "live hello"]);
    // The chat follows the new engine: a message goes into its inbox.
    await s.conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "t9", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "now" }] } } } as any);
    await tick();
    assert.equal(after.itemText("t9"), "now");
  });
});
