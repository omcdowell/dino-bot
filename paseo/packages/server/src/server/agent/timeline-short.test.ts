import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  COMPACT_METADATA_KEY,
  SHORT_REASONING_CHARS,
  shortTimelineItem,
  timelineBodyHash,
} from "./timeline-compact.js";

function shell(output: string, status: "completed" | "running" | "failed" = "completed") {
  return {
    type: "tool_call",
    callId: "call-1",
    name: "bash",
    status,
    error: status === "failed" ? "boom: first line\nsecond line" : null,
    detail: { type: "shell", command: "cat src/a.ts\n# second", output, exitCode: 0 },
  } as AgentTimelineItem;
}
const marker = (item: AgentTimelineItem) =>
  item.type === "tool_call"
    ? (item.metadata?.[COMPACT_METADATA_KEY] as Record<string, unknown> | undefined)
    : undefined;

describe("short timeline items (priority_sync)", () => {
  test("assistant and user text are never cut (same reference)", () => {
    const a: AgentTimelineItem = { type: "assistant_message", text: "x".repeat(80_000) };
    const u: AgentTimelineItem = { type: "user_message", text: "y\n".repeat(20_000) };
    expect(shortTimelineItem(a)).toBe(a);
    expect(shortTimelineItem(u)).toBe(u);
  });

  test("a big final tool call becomes a one-line step with omittedBytes and bodyHash", () => {
    const full = shell("line\n".repeat(10_000));
    const s = shortTimelineItem(full);
    if (s.type !== "tool_call" || s.detail.type !== "shell") throw new Error("type");
    expect(s.detail).toEqual({ type: "shell", command: "cat src/a.ts…", exitCode: 0 });
    expect(s.callId).toBe("call-1");
    expect(s.status).toBe("completed");
    const m = marker(s)!;
    expect(m.short).toBe(true);
    expect(m.omittedBytes).toBeGreaterThan(49_000);
    expect(m.bodyHash).toBe(timelineBodyHash(full));
    expect(String(m.bodyHash)).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(s).length).toBeLessThan(400);
  });

  test("bodyHash only when final; failed keeps the first error line", () => {
    const running = shortTimelineItem(shell("o\n".repeat(5_000), "running"));
    expect(marker(running)?.short).toBe(true);
    expect(marker(running)?.bodyHash).toBeUndefined();
    const failed = shortTimelineItem(shell("o\n".repeat(5_000), "failed"));
    expect(marker(failed)?.bodyHash).toMatch(/^[0-9a-f]{16}$/);
    if (failed.type !== "tool_call") throw new Error("type");
    expect(failed.error).toBe("boom: first line…");
  });

  test("hash is content based: equal items equal hash, any change a new hash", () => {
    expect(timelineBodyHash(shell("abc"))).toBe(timelineBodyHash(shell("abc")));
    expect(timelineBodyHash(shell("abc"))).not.toBe(timelineBodyHash(shell("abd")));
  });

  test("small tool calls stay whole; short is idempotent", () => {
    const small = shell("ok");
    expect(shortTimelineItem(small)).toBe(small);
    const once = shortTimelineItem(shell("z".repeat(9_000)));
    expect(shortTimelineItem(once)).toBe(once);
  });

  test("reasoning keeps a one-line preview and is never dropped", () => {
    const r: AgentTimelineItem = { type: "reasoning", text: `${"r".repeat(500)}\nmore` };
    const s = shortTimelineItem(r);
    if (s.type !== "reasoning") throw new Error("type");
    expect(s.text.length).toBe(SHORT_REASONING_CHARS + 1);
    const tiny: AgentTimelineItem = { type: "reasoning", text: "short" };
    expect(shortTimelineItem(tiny)).toBe(tiny);
  });
});
