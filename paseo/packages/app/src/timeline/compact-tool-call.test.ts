import { beforeEach, expect, test, vi } from "vitest";
import {
  clearFullToolCallCache,
  isCompactToolCall,
  loadFullToolCallDetail,
} from "./compact-tool-call";

beforeEach(() => clearFullToolCallCache());

test("recognises the compact marker", () => {
  expect(isCompactToolCall({ paseoCompact: { omittedBytes: 10 } })).toBe(true);
  expect(isCompactToolCall({})).toBe(false);
  expect(isCompactToolCall(undefined)).toBe(false);
});

test("loads the full detail once and serves re-expands from the cache", async () => {
  const fetchAgentTimelineItem = vi.fn(async () => ({
    item: { type: "tool_call", detail: { type: "shell", command: "ls", output: "full" } },
  }));
  const client = { fetchAgentTimelineItem };
  const first = await loadFullToolCallDetail(client, "a", "c");
  const second = await loadFullToolCallDetail(client, "a", "c");
  expect(first).toEqual({ type: "shell", command: "ls", output: "full" });
  expect(second).toBe(first);
  expect(fetchAgentTimelineItem).toHaveBeenCalledTimes(1);
});

test("a failed load resolves null and is retried next time", async () => {
  const fetchAgentTimelineItem = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ item: { type: "tool_call", detail: { type: "plan", text: "p" } } });
  const client = { fetchAgentTimelineItem };
  expect(await loadFullToolCallDetail(client, "a", "c")).toBeNull();
  expect(await loadFullToolCallDetail(client, "a", "c")).toEqual({ type: "plan", text: "p" });
});
