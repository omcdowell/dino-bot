// Images in a Claude Code bot's chat, as in a pi bot's: the view mod passes a tool's images (a Read of a PNG, a
// screenshot an MCP tool returns, Bash's image output) to the engine, the engine passes them on, and the provider
// puts them on the tool row (`images`), which Paseo stores in its chat image store as it does pi's. A reopened
// chat shows the images the person sent (kept in the profile and named by path in the memory log).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { createCcProvider, IMAGE_NOT_KEPT, piImageText, promptText } from "../server/cc/provider";
import { userText } from "pi-optchat/src/run-log.ts";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerView } from "../claude-code/view/hooks/register.js";

const TMP = mkdtempSync(join(tmpdir(), "cc-images-"));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanup) await c().catch(() => {});
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  return { call: hooks.get("tool.call")!, calls, $ };
}

async function toolDone(e: object, r: object) {
  const { call, calls, $ } = viewMod();
  assert.equal(await call($, e, async () => r), r);
  return calls.find((c) => c.body?.phase === "done")!.body;
}

describe("view mod: a tool's images", () => {
  it("a Read of an image: its bytes go to the engine with the result", async () => {
    const done = await toolDone(
      { tool: "Read", tool_use_id: "tu1", file_path: "/shot.png" },
      { ref: 1, text: "", result: { type: "image", file: { base64: PNG, type: "image/png", originalSize: 70 } } },
    );
    assert.deepEqual(done.images, [{ data: PNG, mimeType: "image/png" }]);
  });

  it("an MCP tool's image blocks (MCP and Messages API shapes) and Bash's image output", async () => {
    const mcp = await toolDone(
      { tool: "mcp__browser__screenshot", tool_use_id: "tu2" },
      {
        ref: 2,
        text: "shot",
        result: [
          { type: "text", text: "shot" },
          { type: "image", data: PNG, mimeType: "image/jpeg" },
          { type: "image", source: { type: "base64", media_type: "image/webp", data: PNG } },
        ],
      },
    );
    assert.deepEqual(mcp.images, [
      { data: PNG, mimeType: "image/jpeg" },
      { data: PNG, mimeType: "image/webp" },
    ]);
    const bash = await toolDone(
      { tool: "Bash", tool_use_id: "tu3", command: "cat x.png" },
      { ref: 3, text: "", result: { stdout: `data:image/png;base64,${PNG}`, stderr: "", interrupted: false, isImage: true } },
    );
    assert.deepEqual(bash.images, [{ data: `data:image/png;base64,${PNG}` }]);
  });

  it("no images: no field (text results, errors, denials)", async () => {
    const text = await toolDone({ tool: "Bash", tool_use_id: "tu4", command: "ls" }, { ref: 4, text: "a\nb", result: { stdout: "a\nb", stderr: "", interrupted: false } });
    assert.equal("images" in text, false);
    const denied = await toolDone({ tool: "Read", tool_use_id: "tu5", file_path: "/x" }, { deny: "no" });
    assert.equal("images" in denied, false);
  });
});

async function botProvider(name: string) {
  const root = join(TMP, name);
  mkdirSync(join(root, "kit"), { recursive: true });
  writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
  const host = new CcHost(join(root, ".cc"));
  const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
  const optchatHome = join(TMP, `${name}-oc`);
  const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome });
  const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"] });
  cleanup.push(async () => {
    await conn.close();
    await host.close();
  });
  const events: ProviderEvent[] = [];
  conn.onEvent((e) => events.push(e));
  return { root, host, conn, events, profileDir: join(optchatHome, "profiles", "kit") };
}

describe("cc provider: images on the timeline", () => {
  it("a tool's images go on its tool row, once it is done; the result text is not cut again", async () => {
    const { root, host, conn, events } = await botProvider("p1");
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const engine = host.engines.get("kit")!;
    const post = (path: string, body: unknown) => engine.handle("POST", path, new URLSearchParams(), body);
    await post("/turn", { running: true, typed: true, text: "look", origin: "composer" });
    await post("/event", { type: "tool", phase: "running", id: "tu1", name: "Read", input: { file_path: "/shot.png" } });
    await post("/event", { type: "tool", phase: "done", id: "tu1", name: "Read", input: { file_path: "/shot.png" }, output: "", images: [{ data: PNG, mimeType: "image/png" }, { data: 7 }] });
    const long = "x".repeat(5000);
    await post("/event", { type: "tool", phase: "done", id: "tu2", name: "Bash", input: { command: "yes" }, output: long });
    const rows = events.flatMap((e) => (e.type === "timeline.item" && e.item.type === "tool_call" ? [e.item as any] : []));
    assert.deepEqual(
      rows.map((r) => [r.callId, r.status, r.images]),
      [
        ["tu1", "running", undefined],
        ["tu1", "completed", [{ data: PNG, mimeType: "image/png" }]],
        ["tu2", "completed", undefined],
      ],
    );
    assert.equal(rows[2].detail.output, long);
  });

  it("a reopened chat's user messages carry the images the person sent, by the file kept in the profile", async () => {
    const { root, host, conn, events, profileDir } = await botProvider("p2");
    const text = promptText(
      [
        { type: "text", text: "this layout" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
      profileDir,
    );
    assert.match(text, /^this layout\n\[image: .*\.png \(read the file to see it\)\]$/);
    const engine = await host.engine("kit", profileDir, { env: {}, botDir: join(root, "kit") });
    await engine.handle("POST", "/append", new URLSearchParams(), { messages: [{ kind: "user", text }, { kind: "talk", text: "Done." }, { kind: "user", text: "[image: /gone.png (read the file to see it)]" }] });
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "replay", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item as any] : []));
    assert.deepEqual(
      items.map((i) => [i.type, i.text, i.images]),
      [
        ["user_message", "this layout", [{ data: PNG, mimeType: "image/png" }]],
        ["assistant_message", "Done.", undefined],
        // A file no longer there keeps its line.
        ["user_message", "[image: /gone.png (read the file to see it)]", undefined],
      ],
    );
  });

  it("a reopened chat shows an image sent while the bot ran on pi, and a note for one pi did not keep", async () => {
    const { root, host, conn, events, profileDir } = await botProvider("p4");
    // What pi-optchat now logs for a pi user message with an image (and Pi's resize note).
    const kept = userText(
      [
        { type: "text", text: "on pi\n\n[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2.02 to map to original image.]" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
      join(profileDir, "images"),
    );
    const placeholder = "[image attachment: available in Pi session; text memory does not preserve image bytes]";
    const engine = await host.engine("kit", profileDir, { env: {}, botDir: join(root, "kit") });
    await engine.handle("POST", "/append", new URLSearchParams(), {
      messages: [
        { kind: "user", text: kept },
        { kind: "user", text: `older\n\n[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2.02 to map to original image.]\n${placeholder}` },
        { kind: "user", text: `\n${placeholder}\n${placeholder}` },
      ],
    });
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "replay", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item as any] : []));
    assert.deepEqual(
      items.map((i) => [i.type, i.text, i.images]),
      [
        ["user_message", "on pi", [{ data: PNG, mimeType: "image/png" }]],
        ["user_message", `older\n${IMAGE_NOT_KEPT}`, undefined],
        ["user_message", `${IMAGE_NOT_KEPT}\n${IMAGE_NOT_KEPT}`, undefined],
      ],
    );
    assert.equal(piImageText("[Image: a note the person typed]"), "[Image: a note the person typed]");
  });

  it("a reopened chat shows the sent images and the tool rows together", async () => {
    const { root, host, conn, events, profileDir } = await botProvider("p3");
    const text = promptText([{ type: "text", text: "look" }, { type: "image", data: PNG, mimeType: "image/png" }], profileDir);
    const engine = await host.engine("kit", profileDir, { env: {}, botDir: join(root, "kit") });
    await engine.handle("POST", "/append", new URLSearchParams(), {
      messages: [{ kind: "user", text }, { kind: "tool", text: 'Bash {"command":"ls"}' }, { kind: "echo", text: "Bash: a.txt" }, { kind: "talk", text: "Seen." }],
    });
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "replay", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item as any] : []));
    assert.deepEqual(
      items.map((i) => [i.type, i.type === "tool_call" ? i.status : i.text, i.images]),
      [
        ["user_message", "look", [{ data: PNG, mimeType: "image/png" }]],
        ["tool_call", "completed", undefined],
        ["assistant_message", "Seen.", undefined],
      ],
    );
  });
});
