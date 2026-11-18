// A Claude Code bot held at a permission prompt or a question in its terminal (L6): the chat gets a permission card,
// so Paseo marks it for attention and pushes, as for a pi bot's permission request. It is answered in the terminal:
// the card goes once the bot moves on, or when the owner dismisses it.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { createCcProvider } from "../server/cc/provider";

const TMP = mkdtempSync(join(tmpdir(), "cc-perm-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanup) await c().catch(() => {});
});

async function open(name: string) {
  const root = join(TMP, name);
  mkdirSync(join(root, "kit"), { recursive: true });
  writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
  const host = new CcHost(join(root, ".cc"));
  const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
  const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(root, "oc") });
  const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence", "permission"] });
  cleanup.push(async () => {
    await conn.close();
    await host.close();
  });
  const events: ProviderEvent[] = [];
  conn.onEvent((e) => events.push(e));
  await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
  for (let k = 0; k < 50 && !host.engines.get("kit"); k++) await tick();
  const engine = host.engines.get("kit")! as any;
  assert.ok(engine, JSON.stringify(events));
  return { conn, events, engine, perms: () => events.filter((e) => e.type === "session.permission" || e.type === "session.permission_resolved") as any[] };
}

describe("cc provider: blocked in the terminal", () => {
  it("declares permission, raises a card, and resolves it once the bot moves on", async () => {
    const { conn, engine, perms } = await open("p1");
    assert.ok(conn.capabilities.includes("permission"));
    engine.emit({ type: "blocked", since: 7 });
    const [req] = perms();
    assert.equal(req.type, "session.permission");
    assert.equal(req.request.id, "blocked-7");
    assert.equal(req.request.kind, "other");
    assert.match(req.request.description, /terminal/);
    assert.deepEqual(req.request.actions.map((a: any) => a.behavior), ["deny"]);
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "hi", origin: "composer" });
    engine.emit({ type: "tool", phase: "running", id: "t1", name: "Bash", input: {} });
    assert.deepEqual(perms().slice(1).map((e) => `${e.type}|${e.permissionId}`), ["session.permission_resolved|blocked-7"]);
  });

  it("dismissed by the owner: resolved at once", async () => {
    const { conn, engine, perms } = await open("p2");
    engine.emit({ type: "blocked", since: 9 });
    await conn.send({ type: "session.permission", sessionId: "s1", permissionId: "blocked-9", response: { behavior: "deny", message: "dismissed" } } as any);
    await tick();
    assert.deepEqual(perms().map((e) => e.type), ["session.permission", "session.permission_resolved"]);
  });
});
