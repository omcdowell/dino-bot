import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  COMPACT_METADATA_KEY,
  COMPACT_PREVIEW_CHARS,
  compactTimelineItem,
  readCompactMarker,
} from "./timeline-compact.js";

function shell(output: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "call-1",
    name: "bash",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "ls -la", output, exitCode: 0 },
  };
}

describe("compact timeline items", () => {
  test("leaves small tool calls and non-tool items untouched (same reference)", () => {
    const small = shell("ok");
    expect(compactTimelineItem(small)).toBe(small);
    const text: AgentTimelineItem = { type: "assistant_message", text: "x".repeat(50_000) };
    expect(compactTimelineItem(text)).toBe(text);
  });

  test("keeps the tail of shell output and marks what it omitted", () => {
    const output = `${"a".repeat(20_000)}THE-END`;
    const compacted = compactTimelineItem(shell(output));
    expect(compacted.type).toBe("tool_call");
    if (compacted.type !== "tool_call" || compacted.detail.type !== "shell") throw new Error();
    expect(compacted.detail.command).toBe("ls -la");
    expect(compacted.detail.exitCode).toBe(0);
    expect(compacted.detail.output?.endsWith("THE-END")).toBe(true);
    expect(compacted.detail.output?.length).toBeLessThanOrEqual(COMPACT_PREVIEW_CHARS + 1);
    const marker = readCompactMarker(compacted);
    expect(marker).not.toBeNull();
    expect(marker?.omittedBytes).toBeGreaterThan(19_000);
    expect(compacted.metadata?.[COMPACT_METADATA_KEY]).toEqual(marker);
  });

  test("keeps the head of file contents, diffs and fetch results", () => {
    const big = `HEAD${"z".repeat(30_000)}`;
    const items: AgentTimelineItem[] = [
      {
        type: "tool_call",
        callId: "r",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "/a.ts", content: big },
      },
      {
        type: "tool_call",
        callId: "e",
        name: "edit",
        status: "completed",
        error: null,
        detail: {
          type: "edit",
          filePath: "/a.ts",
          oldString: big,
          newString: big,
          unifiedDiff: big,
        },
      },
      {
        type: "tool_call",
        callId: "f",
        name: "fetch",
        status: "completed",
        error: null,
        detail: { type: "fetch", url: "https://x", result: big },
      },
    ];
    for (const item of items) {
      const compacted = compactTimelineItem(item);
      const size = JSON.stringify(compacted).length;
      expect(size).toBeLessThan(4_000);
      expect(JSON.stringify(compacted)).toContain("HEAD");
      expect(readCompactMarker(compacted)).not.toBeNull();
    }
  });

  test("preserves existing metadata and the tool call identity", () => {
    const item: AgentTimelineItem = {
      ...shell("y".repeat(10_000)),
      metadata: { exitSignal: "none" },
    };
    const compacted = compactTimelineItem(item);
    if (compacted.type !== "tool_call") throw new Error();
    expect(compacted.callId).toBe("call-1");
    expect(compacted.status).toBe("completed");
    expect(compacted.metadata?.exitSignal).toBe("none");
  });

  test("compacts unknown tool payloads to a string preview", () => {
    const item: AgentTimelineItem = {
      type: "tool_call",
      callId: "u",
      name: "mcp__thing",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: { q: "a" }, output: { rows: "r".repeat(20_000) } },
    };
    const compacted = compactTimelineItem(item);
    if (compacted.type !== "tool_call" || compacted.detail.type !== "unknown") throw new Error();
    expect(compacted.detail.input).toEqual({ q: "a" });
    expect(typeof compacted.detail.output).toBe("string");
    expect(JSON.stringify(compacted).length).toBeLessThan(4_000);
  });

  test("is idempotent", () => {
    const once = compactTimelineItem(shell("q".repeat(30_000)));
    expect(compactTimelineItem(once)).toBe(once);
  });
});
