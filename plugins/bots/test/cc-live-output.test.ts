// A Claude Code bot's Bash output shows while the command runs, as a pi bot's does (pi's tool_execution_update):
// Claude Code writes a shell command's output to <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output as it
// comes; the view mod reads the file that appeared there while the call runs and posts its tail to the engine, which
// passes it on, and the provider shows it on the running tool row.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { createCcProvider } from "../server/cc/provider";
import { ccToolDetail } from "../server/cc/tool-detail";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerView } from "../claude-code/view/hooks/register.js";

const TMP = mkdtempSync(join(tmpdir(), "cc-live-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanup) await c().catch(() => {});
});

/** The view mod over a fake file system: `files` maps a path to its text (a folder is any prefix). */
function viewMod(files: Map<string, string>, sid = "sess-1") {
  const hooks = new Map<string, Function>();
  registerView((event: string, fn: Function) => hooks.set(event, fn));
  const calls: Array<{ path: string; body: any }> = [];
  const list = async (dir: string) => {
    const out = new Map<string, { name: string; kind: string; size?: number }>();
    for (const [p, text] of files) {
      if (!p.startsWith(dir + "/")) continue;
      const rest = p.slice(dir.length + 1);
      const name = rest.split("/")[0]!;
      out.set(name, rest.includes("/") ? { name, kind: "dir" } : { name, kind: "file", size: Buffer.byteLength(text) });
    }
    if (!out.size) throw new Error(`ENOENT ${dir}`);
    return [...out.values()];
  };
  const $ = {
    env: { get: async (k: string) => ({ OPTCHAT_ENGINE_FILE: "/engine.json", OPTCHAT_TOOL_POLL_MS: "10", TMPDIR: "/tmp" })[k] ?? "" },
    session: { id: async () => sid },
    fs: {
      read: async (p: string) => (p === "/engine.json" ? JSON.stringify({ url: "http://engine/b/kit", token: "t" }) : files.get(p)),
      write: async () => {},
      list,
      exists: async (p: string) => [...files.keys()].some((k) => k.startsWith(p + "/")),
    },
    http: {
      fetch: async (url: string, init: { method: string; body?: string }) => {
        calls.push({ path: url.replace("http://engine/b/kit", ""), body: init.body ? JSON.parse(init.body) : undefined });
        return { status: 200, text: "{}" };
      },
    },
    ui: { log: () => {}, status: () => {} },
  };
  return { call: hooks.get("tool.call")!, calls, $ };
}

describe("view mod: a Bash call's output while it runs", () => {
  it("posts the output so far of the file that appeared in the session's tasks folder, then the result", async () => {
    const tasks = "/tmp/claude-1000/-home-u-bots-kit/sess-1/tasks";
    // A background task's output was there before: it is not this call's.
    const files = new Map([["/tmp/other/x", ""], [`${tasks}/bgold.output`, "old"]]);
    const { call, calls, $ } = viewMod(files);
    const result = { ref: 1, text: "line 1\nline 2\nline 3", result: { stdout: "line 1\nline 2\nline 3", stderr: "", interrupted: false } };
    const r = await call($, { tool: "Bash", tool_use_id: "tu1", command: "for i in 1 2 3; do echo line $i; sleep 1; done" }, async () => {
      await tick(5);
      files.set(`${tasks}/b1.output`, "line 1\n");
      await tick(60);
      files.set(`${tasks}/b1.output`, "line 1\nline 2\n");
      await tick(60);
      files.delete(`${tasks}/b1.output`);
      return result;
    });
    assert.equal(r, result);
    const posts = calls.filter((c) => c.path === "/event").map((c) => c.body);
    assert.deepEqual(
      posts.map((b) => [b.phase, b.output]),
      [
        ["running", undefined],
        ["running", "line 1\n"],
        ["running", "line 1\nline 2\n"],
        ["done", "line 1\nline 2\nline 3"],
      ],
    );
    assert.ok(posts.every((b) => b.id === "tu1" && b.name === "Bash"));
  });

  it("a background command and other tools post no live output", async () => {
    const tasks = "/tmp/claude-1000/p/sess-1/tasks";
    const files = new Map([[`${tasks}/a.output`, "x"]]);
    const { call, calls, $ } = viewMod(files);
    await call($, { tool: "Bash", tool_use_id: "tu2", command: "sleep 5", run_in_background: true }, async () => {
      files.set(`${tasks}/b.output`, "started");
      await tick(50);
      return { ref: 2, text: "Command running in background with ID: b" };
    });
    await call($, { tool: "Grep", tool_use_id: "tu3", pattern: "x" }, async () => {
      files.set(`${tasks}/c.output`, "zzz");
      await tick(50);
      return { ref: 3, text: "a.ts" };
    });
    const running = calls.filter((c) => c.body?.phase === "running");
    assert.deepEqual(
      running.map((c) => c.body.output),
      [undefined, undefined],
    );
  });
});

describe("cc provider: a running tool's output", () => {
  it("the shell detail carries the output so far while it runs, with no exit code yet", async () => {
    assert.deepEqual(ccToolDetail({ name: "Bash", input: { command: "make" }, output: "building…", done: false }), { type: "shell", command: "make", output: "building…" });
  });

  it("the engine passes a running tool's output on and the row shows it, then the result", async () => {
    const root = join(TMP, "p1");
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
    const host = new CcHost(join(root, ".cc"));
    const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, "p1-oc") });
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
    await post("/turn", { running: true, typed: true, text: "build it", origin: "composer" });
    await post("/event", { type: "tool", phase: "running", id: "tu1", name: "Bash", input: { command: "make" } });
    await post("/event", { type: "tool", phase: "running", id: "tu1", name: "Bash", input: { command: "make" }, output: "cc a.c\n" });
    await post("/event", { type: "tool", phase: "done", id: "tu1", name: "Bash", input: { command: "make" }, output: "cc a.c\nok" });
    const rows = events.flatMap((e) => (e.type === "timeline.item" && e.item.type === "tool_call" ? [e.item as any] : []));
    assert.deepEqual(
      rows.map((r) => [r.id, r.status, r.detail.output, r.detail.exitCode]),
      [
        ["c-tu1", "running", undefined, undefined],
        ["c-tu1", "running", "cc a.c\n", undefined],
        ["c-tu1", "completed", "cc a.c\nok", 0],
      ],
    );
  });
});
