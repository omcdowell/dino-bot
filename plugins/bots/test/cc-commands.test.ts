// The app's slash commands for a bot on Claude Code, as for a pi bot: the provider lists /compact, /optchat and /skill:<name>
// for each skill in the bot's prompt; /skill:<name> sends pi's skill message (the SKILL.md body in a <skill> block,
// then the arguments); /compact gets OptChat's answer (it compacts after every turn) and starts no turn.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { createCcProvider, replayItems } from "../server/cc/provider";
import { skillCommandText } from "../server/cc/skills";
import { OPTCHAT_COMMAND } from "../server/cc/profile-tools";

const TMP = mkdtempSync(join(tmpdir(), "cc-commands-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanup) await c().catch(() => {});
});

async function bot(name: string) {
  const root = join(TMP, name);
  mkdirSync(join(root, "kit"), { recursive: true });
  writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
  const skillsDir = join(root, "skills");
  mkdirSync(join(skillsDir, "tdd"), { recursive: true });
  writeFileSync(join(skillsDir, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test first.\n---\n\n# TDD\n\nRed, green, refactor.\n");
  const host = new CcHost(join(root, ".cc"));
  const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
  const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(root, "oc"), skillsDir, models: async () => [] });
  const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.command", "prompt.steer", "session.persistence"] });
  cleanup.push(async () => {
    await conn.close();
    await host.close();
  });
  const events: ProviderEvent[] = [];
  conn.onEvent((e) => events.push(e));
  await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: { HOME: root, PI_CODING_AGENT_DIR: join(root, "pi") }, mcpServers: {}, settings: {}, persist: true } });
  await tick(50);
  const command = async (id: string, name: string, args: string) => {
    await conn.send({ type: "session.prompt", requestId: `p-${id}`, sessionId: "s1", prompt: { clientMessageId: id, delivery: "auto", input: { type: "command", name, arguments: args } } } as any);
    await tick(30);
  };
  return { conn, events, host, skillsDir, command, engine: host.engines.get("kit")! };
}

describe("cc provider: slash commands", () => {
  it("declares prompt.command and lists /compact, /optchat and a /skill:<name> per skill of the bot", async () => {
    const { conn, events } = await bot("b1");
    assert.ok(conn.capabilities.includes("prompt.command"));
    const lists = events.flatMap((e) => (e.type === "session.commands" ? [e.commands] : []));
    assert.equal(lists.length, 1);
    assert.deepEqual(lists[0], [
      { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
      OPTCHAT_COMMAND,
      { name: "skill:tdd", description: "Test first." },
    ]);
  });

  it("/skill:<name> args sends pi's skill message as a turn; the chat shows the command", async () => {
    const { events, engine, skillsDir, command } = await bot("b2");
    await command("m1", "skill:tdd", "fix the parser");
    const path = join(skillsDir, "tdd", "SKILL.md");
    // Typed as any message: a leading space keeps the composer from reading `<` as a mode.
    assert.equal(engine.itemText("m1"), ` <skill name="tdd" location="${path}">\nReferences are relative to ${join(skillsDir, "tdd")}.\n\n# TDD\n\nRed, green, refactor.\n</skill>\n\nfix the parser`);
    const row = events.find((e) => e.type === "timeline.item" && e.item.type === "user_message") as any;
    assert.equal(row.item.text, "/skill:tdd fix the parser");
    const result = events.find((e) => e.type === "session.prompt_result") as any;
    assert.deepEqual(result.result, { type: "turn", turnId: "m1" });
    // The logged message comes back as the command on a reopened chat.
    assert.equal(skillCommandText(engine.itemText("m1")!), "/skill:tdd fix the parser");
    assert.equal(replayItems([{ i: 0, kind: "user", text: engine.itemText("m1")!, date: "d" }])[0]!.item.type === "user_message" && (replayItems([{ i: 0, kind: "user", text: engine.itemText("m1")!, date: "d" }])[0]!.item as any).text, "/skill:tdd fix the parser");
  });

  it("/compact: OptChat's note, no turn and nothing for the TUI", async () => {
    const { events, engine, command } = await bot("b3");
    await command("m2", "compact", "");
    assert.equal(engine.itemText("m2"), undefined);
    const note = events.find((e) => e.type === "timeline.item" && e.item.type === "notification") as any;
    assert.match(note.item.message, /OptChat manages history between turns/);
    assert.deepEqual((events.find((e) => e.type === "session.prompt_result") as any).result, { type: "completed" });
    assert.equal(events.some((e) => e.type === "session.turn"), false);
  });

  it("an unknown command fails with its name", async () => {
    const { events, engine, command } = await bot("b4");
    await command("m3", "skill:nope", "");
    assert.equal(engine.itemText("m3"), undefined);
    assert.deepEqual((events.find((e) => e.type === "session.prompt_result") as any).result, { type: "failed", error: { message: "Unknown command: /skill:nope" } });
  });

  it("a skill added later is listed with the next message", async () => {
    const { events, skillsDir, conn } = await bot("b5");
    mkdirSync(join(skillsDir, "herdr"), { recursive: true });
    writeFileSync(join(skillsDir, "herdr", "SKILL.md"), "---\nname: herdr\ndescription: Panes.\n---\nbody\n");
    await conn.send({ type: "session.prompt", requestId: "p", sessionId: "s1", prompt: { clientMessageId: "m4", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } } } as any);
    await tick(30);
    const lists = events.flatMap((e) => (e.type === "session.commands" ? [e.commands.map((c) => c.name)] : []));
    assert.deepEqual(lists, [
      ["compact", "optchat", "skill:tdd"],
      ["compact", "optchat", "skill:herdr", "skill:tdd"],
    ]);
  });
});
