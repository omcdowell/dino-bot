import { expect, test } from "vitest";
import {
  archivedChainEnd,
  chooseTimelineCut,
  parseTimelinePageId,
  planTimelineSeal,
  timelinePageId,
  type PositionedItem,
} from "./timeline-persistence";

function item(
  seq: number,
  kind = "assistant_message",
  turnId = "t1",
): PositionedItem & { id: string } {
  return { id: `i${seq}`, kind, turnId, timelineCursor: { epoch: "e", seq } };
}

function run(count: number, start = 1) {
  return Array.from({ length: count }, (_, index) => item(start + index));
}

test("page ids round-trip and sort by sequence", () => {
  const id = timelinePageId("agent-1", "ep|och", 7, 120);
  expect(parseTimelinePageId(id)).toEqual({
    agentId: "agent-1",
    epoch: "ep|och",
    startSeq: 7,
    endSeq: 120,
  });
  expect(timelinePageId("a", "e", 9, 10) < timelinePageId("a", "e", 10, 11)).toBe(true);
});

test("a short timeline keeps its full range in the head and seals nothing", () => {
  const plan = planTimelineSeal({
    items: run(40),
    range: { epoch: "e", startSeq: 1, endSeq: 40 },
    hasOlder: false,
    archivedEnd: null,
  });
  expect(plan?.pages).toEqual([]);
  expect(plan?.head.range).toEqual({ epoch: "e", startSeq: 1, endSeq: 40 });
  expect(plan?.head.hasOlder).toBe(false);
});

test("past the seal threshold the oldest items become pages and the head range is trimmed", () => {
  const plan = planTimelineSeal({
    items: run(250),
    range: { epoch: "e", startSeq: 1, endSeq: 250 },
    hasOlder: true,
    archivedEnd: null,
  });
  if (!plan) throw new Error("expected a plan");
  expect(plan.pages.map((page) => page.range)).toEqual([
    { epoch: "e", startSeq: 1, endSeq: 100 },
    { epoch: "e", startSeq: 101, endSeq: 200 },
  ]);
  expect(plan.pages[0]?.hasOlder).toBe(true);
  expect(plan.head.items).toHaveLength(50);
  expect(plan.head.range).toEqual({ epoch: "e", startSeq: 201, endSeq: 250 });
  expect(plan.head.hasOlder).toBe(true);
});

test("items already archived are left out of the head and not sealed again", () => {
  const plan = planTimelineSeal({
    items: run(160),
    range: { epoch: "e", startSeq: 1, endSeq: 160 },
    hasOlder: false,
    archivedEnd: 100,
  });
  expect(plan?.pages).toEqual([]);
  expect(plan?.head.range).toEqual({ epoch: "e", startSeq: 101, endSeq: 160 });
  expect(plan?.head.hasOlder).toBe(true);
});

test("never cuts between interleaved items (a tool call completing after later rows)", () => {
  // Display order: tool call started at 1 and completed at 5, then assistant rows 2..4, 6.. .
  const tool = { ...item(5, "tool_call"), id: "tool" };
  const items = [item(0), tool, item(2), item(3), item(4), item(6), item(7)];
  // Cutting after the tool (k=2) would claim [.., 5] while rows 2..4 stay in the head.
  expect(chooseTimelineCut(items, 3)).toBe(1);
  expect(chooseTimelineCut(items, 4)).toBe(1);
  expect(chooseTimelineCut(items, 6)).toBe(6);
});

test("prefers a turn boundary when it keeps at least half the page", () => {
  const items = [
    ...Array.from({ length: 6 }, (_, index) => item(index + 1, "assistant_message", "t1")),
    item(7, "user_message", "t2"),
    ...Array.from({ length: 3 }, (_, index) => item(index + 8, "assistant_message", "t2")),
  ];
  expect(chooseTimelineCut(items, 8)).toBe(6);
  expect(chooseTimelineCut(items, 9)).toBe(6);
});

test("a head with no valid cut beyond the cap is stored display-only", () => {
  // Every item's sequence is below the first item's: no cut is ever valid.
  const items = [item(10_000), ...run(500)];
  expect(
    planTimelineSeal({
      items,
      range: { epoch: "e", startSeq: 1, endSeq: 10_000 },
      hasOlder: false,
      archivedEnd: null,
    }),
  ).toBeNull();
});

test("the archived chain follows contiguous pages of the same epoch only", () => {
  const pages = [
    { agentId: "a", epoch: "e", startSeq: 1, endSeq: 100 },
    { agentId: "a", epoch: "e", startSeq: 101, endSeq: 180 },
    { agentId: "a", epoch: "e", startSeq: 300, endSeq: 400 },
    { agentId: "a", epoch: "old", startSeq: 181, endSeq: 299 },
  ];
  expect(archivedChainEnd(pages, "e", 1)).toBe(180);
  expect(archivedChainEnd(pages, "e", 150)).toBe(180);
  expect(archivedChainEnd(pages, "e", 200)).toBe(199);
});
