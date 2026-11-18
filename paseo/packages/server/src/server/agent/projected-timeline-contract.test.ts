import { expect, test } from "vitest";

test("retains only the latest cumulative Pi tool progress payload", async () => {
  const { parseToolArgs, parseToolResult, mapToolDetail } =
    await import("./providers/pi/tool-call-mapper.js");
  const { InMemoryAgentTimelineStore } = await import("./agent-timeline-store.js");
  const store = new InMemoryAgentTimelineStore();
  store.initialize("agent");
  const tool = parseToolArgs("custom_progress", {});
  const messages: string[] = [];
  for (let index = 0; index < 20; index++) {
    messages.push(`Update ${index}: ${"x".repeat(2048)}`);
    const result = parseToolResult({
      content: [{ type: "text", text: "running" }],
      details: { results: [{ messages: [...messages] }] },
    });
    store.append("agent", {
      type: "tool_call",
      callId: "same-call",
      name: "custom_progress",
      status: "running",
      error: null,
      detail: mapToolDetail(tool, result),
    });
  }
  const history = store.fetch("agent", { limit: 0 });
  expect(history.rows).toHaveLength(1);
  expect(history.rows[0]).toMatchObject({
    seqStart: 1,
    seqEnd: 20,
    item: { detail: { output: { details: { results: [{ messages }] } } } },
  });
  expect(JSON.stringify(history.rows).length).toBeLessThan(50_000);
});
