// Claude Code's <task-notification> (a background task ended) on a Claude Code bot: the app shows a row for the task,
// linked to the call that started it, not a message from the person; the bot's memory logs it as a tool result
// (echo), not as `user`. Covers server/cc/task-notification.ts, the provider, and the inbox and view mods.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { createCcProvider } from "../server/cc/provider";
import { parseTaskNotification, taskNotificationItem } from "../server/cc/task-notification";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerInbox } from "../claude-code/inbox/hooks/register.js";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerView } from "../claude-code/view/hooks/register.js";

const TMP = mkdtempSync(join(tmpdir(), "cc-task-notify-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanup) await c().catch(() => {});
});

// As Yoda's session got it (b22d6b21, 15 Nov 06:25:45Z).
const NOTE = `<task-notification>
<task-id>bznd0x0c1</task-id>
<tool-use-id>toolu_018xXMXFCfR3UpiqyeCQzCr2</tool-use-id>
<output-file>/home/u/tmp/tasks/bznd0x0c1.output</output-file>
<status>completed</status>
<summary>Background command "Locate the workers skill" completed (exit code 0)</summary>
</task-notification>`;

describe("task notification", () => {
  it("parses Claude Code's notification; anything else is not one", () => {
    assert.deepEqual(parseTaskNotification(NOTE), {
      taskId: "bznd0x0c1",
      toolUseId: "toolu_018xXMXFCfR3UpiqyeCQzCr2",
      status: "completed",
      summary: 'Background command "Locate the workers skill" completed (exit code 0)',
      outputFile: "/home/u/tmp/tasks/bznd0x0c1.output",
    });
    assert.equal(parseTaskNotification("hello"), null);
    assert.equal(parseTaskNotification("what does <task-notification> mean?"), null);
  });

  it("is a tool row for the task: label = the summary, linked to the call; failed and killed tasks show so", () => {
    const n = parseTaskNotification(NOTE)!;
    assert.deepEqual(taskNotificationItem(n, "t-x"), {
      type: "tool_call",
      id: "c-task-bznd0x0c1",
      callId: "task-bznd0x0c1",
      name: "task_notification",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        label: 'Background command "Locate the workers skill" completed (exit code 0)',
        icon: "square_terminal",
        text: "Output: /home/u/tmp/tasks/bznd0x0c1.output\nStarted by call toolu_018xXMXFCfR3UpiqyeCQzCr2",
      },
      metadata: {
        synthetic: true,
        source: "claude_task_notification",
        taskId: "bznd0x0c1",
        toolUseId: "toolu_018xXMXFCfR3UpiqyeCQzCr2",
        status: "completed",
        outputFile: "/home/u/tmp/tasks/bznd0x0c1.output",
      },
    });
    const failed = taskNotificationItem({ ...n, status: "failed", summary: 'Background command "x" failed with exit code 2' }, "t");
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.error, { message: 'Background command "x" failed with exit code 2' });
    assert.equal(taskNotificationItem({ ...n, status: "killed" }, "t").status, "canceled");
    const bare = taskNotificationItem({ taskId: null, toolUseId: null, status: null, summary: null, outputFile: null }, "t-1");
    assert.equal(bare.id, "c-task-t-1");
    assert.equal((bare.detail as { label: string }).label, "Background task notification");
  });
});

describe("cc provider: a background task's notification", () => {
  async function setup(name: string) {
    const root = join(TMP, name);
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", ".optchat-profile"), `${name}\n`);
    const host = new CcHost(join(root, ".cc"));
    const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, `oc-${name}`) });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    cleanup.push(async () => {
      await conn.close();
      await host.close();
    });
    const engine = host.engines.get("kit")!;
    const turn = (body: unknown) => engine.handle("POST", "/turn", new URLSearchParams(), body);
    const shown = () =>
      events
        .slice(3)
        .map((e) => (e.type === "timeline.item" ? `${e.item.type}:${(e.item as any).text ?? (e.item as any).detail?.label}:${(e.item as any).status ?? ""}` : e.type === "session.turn" ? `turn:${e.state}` : e.type));
    return { turn, shown, events };
  }

  it("shows as the task's row, not a message from the person; its turn runs as any other", async () => {
    const { turn, shown } = await setup("n1");
    await turn({ running: true, typed: true, text: NOTE, origin: "task-notification" });
    await turn({ running: false, answered: true });
    // A prompt the person typed in the TUI still shows as theirs.
    await turn({ running: true, typed: true, text: "typed here", origin: "composer" });
    assert.deepEqual(shown(), [
      'tool_call:Background command "Locate the workers skill" completed (exit code 0):completed',
      "turn:started",
      "turn:completed",
      "user_message:typed here:",
      "turn:started",
    ]);
  });

  it("an older inbox mod (no origin) is caught by the text; an unparsed notification origin still is no user message", async () => {
    const { turn, shown } = await setup("n2");
    await turn({ running: true, typed: true, text: NOTE });
    await turn({ running: false, answered: true });
    await turn({ running: true, typed: true, text: "Agent \"x\" finished", origin: "task-notification" });
    assert.deepEqual(shown(), [
      'tool_call:Background command "Locate the workers skill" completed (exit code 0):completed',
      "turn:started",
      "turn:completed",
      'tool_call:Agent "x" finished:completed',
      "turn:started",
    ]);
  });
});

/** A fake mod runtime: the engine answers from `reply`; every call is recorded. */
function fakeMod(register: (on: (event: string, fn: Function) => void) => void, reply: (method: string, path: string, body: any) => unknown) {
  const hooks = new Map<string, Function>();
  register((event, fn) => hooks.set(event, fn));
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const $ = {
    env: { get: async (k: string) => (k === "OPTCHAT_ENGINE_FILE" ? "/engine.json" : k === "OPTCHAT_STRIP" ? "1" : "") },
    fs: { read: async () => JSON.stringify({ url: "http://engine/b/kit", token: "t" }), write: async () => {} },
    http: {
      fetch: async (url: string, init: { method: string; body?: string }) => {
        const path = url.replace("http://engine/b/kit", "");
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method, path, body });
        return { status: 200, text: JSON.stringify(reply(init.method, path, body) ?? {}) };
      },
    },
    ui: { log: () => {}, status: () => {} },
    clock: { now: async () => Date.now(), every: () => {} },
  };
  return { hooks, calls, $ };
}

describe("claude-code mods: a background task's notification", () => {
  it("inbox mod: a submit Claude Code made itself carries its origin to the engine", async () => {
    const { hooks, calls, $ } = fakeMod(registerInbox, () => ({ ok: true }));
    const submit = hooks.get("prompt.submit")!;
    const next = async (e: unknown) => e;
    await submit($, { text: NOTE, origin: { kind: "task-notification" } }, next);
    await submit($, { text: "hi", origin: { kind: "composer" } }, next);
    await submit($, { text: "hi" }, next);
    // Into the running turn (Claude Code names it: turnId): no turn of its own.
    await submit($, { text: NOTE, origin: { kind: "task-notification" }, turnId: "tu-1" }, next);
    assert.deepEqual(
      calls.map((c) => [c.path, c.body]),
      [
        ["/turn", { running: true, typed: true, into: false, text: NOTE, origin: "task-notification" }],
        ["/turn", { running: true, typed: true, into: false, text: "hi", origin: "composer" }],
        ["/turn", { running: true, typed: true, into: false, text: "hi" }],
        ["/turn", { running: true, typed: true, into: true, text: NOTE, origin: "task-notification" }],
      ],
    );
  });

  it("view mod: memory logs the notification as an echo, never as the person's words, and not as a previous request", async () => {
    const { hooks, calls, $ } = fakeMod(registerView, (method, path) =>
      path === "/append" ? { ids: [1, 2, 3, 4], total: 4 } : path.startsWith("/view") ? { view: "<chat>\nv\n</chat>", total: 4, bytes: 10, previousExchange: true, previousExchangeBytes: 100_000 } : {},
    );
    const compact = hooks.get("session.compact")!;
    const r = await compact(
      $,
      {
        trigger: "manual",
        messages: [
          { role: "user", text: NOTE, toolUses: [] },
          { role: "assistant", text: "", toolUses: [{ tool_use_id: "tu2", tool: "Bash", input: { command: "cat /home/u/tmp/tasks/bznd0x0c1.output" } }] },
          { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "tu2", text: "/x/workers/SKILL.md" }] },
          { role: "assistant", text: "Found it.", toolUses: [] },
        ],
      },
      async (e: unknown) => e,
    );
    const append = calls.find((c) => c.path === "/append")!;
    // Kind and text (calls and results carry their call for the tool digest too: cc-memory.test.ts).
    assert.deepEqual(append.body.messages.map(({ kind, text }: any) => ({ kind, text })), [
      {
        kind: "echo",
        text: 'Background task bznd0x0c1 (call toolu_018xXMXFCfR3UpiqyeCQzCr2) completed: Background command "Locate the workers skill" completed (exit code 0). Output file: /home/u/tmp/tasks/bznd0x0c1.output',
      },
      { kind: "tool", text: 'Bash {"command":"cat /home/u/tmp/tasks/bznd0x0c1.output"}' },
      { kind: "echo", text: "Bash: /x/workers/SKILL.md" },
      { kind: "talk", text: "Found it." },
    ]);
    // No request from the person: no previous exchange carried, just the view.
    assert.deepEqual(r, { messages: [{ role: "user", text: "<chat>\nv\n</chat>", toolUses: [] }] });
  });
});
