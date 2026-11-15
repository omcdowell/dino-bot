// Claude Code tool calls as typed Paseo tool details (server/cc/tool-detail.ts), so the app shows what a tool did.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ccToolDetail } from "../server/cc/tool-detail";

const done = (name: string, input: unknown, output?: string, isError = false) => ccToolDetail({ name, input, output, done: true, isError });
const running = (name: string, input: unknown) => ccToolDetail({ name, input, done: false });

describe("cc tool detail", () => {
  it("Bash is a shell row: the command while it runs, then its output and exit code", () => {
    assert.deepEqual(running("Bash", { command: "date", description: "Show the date" }), { type: "shell", command: "date" });
    assert.deepEqual(done("Bash", { command: "date" }, "Sat Nov 15"), { type: "shell", command: "date", output: "Sat Nov 15", exitCode: 0 });
    assert.deepEqual(done("Bash", { command: "false" }, "Exit code 1\nboom", true), { type: "shell", command: "false", output: "Exit code 1\nboom", exitCode: 1 });
    assert.deepEqual(done("Bash", { command: "x" }, "denied", true), { type: "shell", command: "x", output: "denied", exitCode: null });
    assert.deepEqual(done("Bash", { command: "sleep 9", run_in_background: true }, "started"), { type: "shell", command: "sleep 9", output: "started", exitCode: null });
    // Moved to the background on its timeout: no exit code yet (its <task-notification> brings it later).
    const moved = "Command did not complete within its 120s timeout and was moved to the background (ID: b1). Output is being written to: /t/b1.output.";
    assert.deepEqual(done("Bash", { command: "find /" }, moved), { type: "shell", command: "find /", output: moved, exitCode: null });
    // A command that merely prints those words exited 0.
    assert.equal((done("Bash", { command: "echo" }, "the job was moved to the background") as { exitCode?: unknown }).exitCode, 0);
  });

  it("Read, Write, Edit and MultiEdit name the file", () => {
    assert.deepEqual(running("Read", { file_path: "/a/b.ts", offset: 10, limit: 5 }), { type: "read", filePath: "/a/b.ts", offset: 10, limit: 5 });
    assert.deepEqual(done("Read", { file_path: "/a/b.ts" }, "1\tx"), { type: "read", filePath: "/a/b.ts", content: "1\tx" });
    assert.deepEqual(done("Read", { file_path: "/nope" }, "File does not exist.", true), { type: "read", filePath: "/nope" });
    assert.deepEqual(running("Write", { file_path: "/a/n.md", content: "hi" }), { type: "write", filePath: "/a/n.md", content: "hi" });
    assert.deepEqual(done("Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y", replace_all: false }, "ok"), {
      type: "edit",
      filePath: "/a/b.ts",
      oldString: "x",
      newString: "y",
    });
    assert.deepEqual(
      running("MultiEdit", { file_path: "/a/b.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }),
      { type: "edit", filePath: "/a/b.ts", oldString: "a\n…\nc", newString: "b\n…\nd" },
    );
  });

  it("Grep, Glob and WebSearch are searches; WebFetch is a fetch", () => {
    assert.deepEqual(done("Grep", { pattern: "TODO", path: "src", output_mode: "content" }, "src/a.ts:1:TODO"), {
      type: "search",
      query: "TODO",
      toolName: "grep",
      content: "src/a.ts:1:TODO",
      mode: "content",
    });
    assert.deepEqual(done("Glob", { pattern: "**/*.ts" }, "/r/a.ts\n/r/b.ts"), {
      type: "search",
      query: "**/*.ts",
      toolName: "glob",
      content: "/r/a.ts\n/r/b.ts",
      filePaths: ["/r/a.ts", "/r/b.ts"],
      numFiles: 2,
    });
    assert.deepEqual(running("WebSearch", { query: "paseo" }), { type: "search", query: "paseo", toolName: "web_search" });
    assert.deepEqual(done("WebFetch", { url: "https://x.dev", prompt: "summary" }, "It is x."), { type: "fetch", url: "https://x.dev", prompt: "summary", result: "It is x." });
  });

  it("Task/Agent, Skill, ExitPlanMode and TodoWrite get their own rows", () => {
    assert.deepEqual(running("Task", { subagent_type: "Explore", description: "Find the bug", prompt: "…" }), {
      type: "sub_agent",
      subAgentType: "Explore",
      description: "Find the bug",
      log: "",
    });
    assert.deepEqual(done("Agent", { description: "d" }, "found it"), { type: "sub_agent", description: "d", log: "found it" });
    assert.deepEqual(done("Skill", { skill: "tdd" }, "loaded"), { type: "plain_text", label: "tdd", icon: "sparkles", text: "loaded" });
    assert.deepEqual(running("ExitPlanMode", { plan: "1. do it" }), { type: "plan", text: "1. do it" });
    assert.deepEqual(
      running("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] }),
      { type: "plain_text", label: "1/3 done", icon: "wrench", text: "[x] a\n[~] b\n[ ] c" },
    );
  });

  it("anything else, or a call without its key argument, stays unknown with the raw input and output", () => {
    assert.deepEqual(done("zoom", { id: 3 }, "msg"), { type: "unknown", input: { id: 3 }, output: "msg" });
    assert.deepEqual(running("mcp__x__y", { a: 1 }), { type: "unknown", input: { a: 1 }, output: null });
    assert.deepEqual(running("Bash", {}), { type: "unknown", input: {}, output: null });
    assert.deepEqual(running("Read", null), { type: "unknown", input: null, output: null });
  });
});
