import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatMessageAt,
  newestTime,
  chatPreview,
  dmPreview,
  latestPreview,
  oneLine,
  PREVIEW_MAX,
  PREVIEW_TAIL_LONG,
  PreviewsService,
  turnFillsWindow,
  turnStartedAt,
  type PreviewEntry,
} from "../server/previews";

const e = (timestamp: string, type: string, extra: Partial<PreviewEntry["item"]> = {}, turnId: string | null = "t1"): PreviewEntry => ({
  timestamp,
  turnId,
  item: { type, ...extra },
});

test("oneLine strips markdown, collapses whitespace and cuts with an ellipsis", () => {
  assert.equal(oneLine("## Done\n\n- **Fixed** the `mirror` [sync](http://x)  now"), "Done Fixed the mirror sync now");
  assert.equal(oneLine("a ```code\nblock``` b"), "a b");
  // Tables: the separator row and rules go, each row reads "cell · cell" (visual-bugs 3: raw "| table |" text).
  assert.equal(
    oneLine("Here:\n\n| Task | Owner |\n|------|:-----:|\n| **Copy** | Scrat |\n\n---\nDone."),
    "Here: Task · Owner Copy · Scrat Done.",
  );
  const long = oneLine("x".repeat(500));
  assert.equal(long.length, PREVIEW_MAX);
  assert.ok(long.endsWith("…"));
});

test("chatPreview takes the last assistant message, skipping tools and reasoning", () => {
  const entries = [
    e("2026-10-08T10:00:00Z", "user_message", { text: "hi" }),
    e("2026-10-08T10:00:01Z", "assistant_message", { text: "First." }),
    e("2026-10-08T10:00:02Z", "assistant_message", { text: "Done. The sync is fixed." }),
    e("2026-10-08T10:00:03Z", "tool_call"),
    e("2026-10-08T10:00:04Z", "reasoning", { text: "hmm" }),
  ];
  assert.deepEqual(chatPreview(entries), { kind: "reply", text: "Done. The sync is fixed.", ts: "2026-10-08T10:00:02Z" });
});

test("chatPreview reports a trailing error; null when nothing fits", () => {
  const entries = [e("2026-10-08T10:00:01Z", "assistant_message", { text: "ok" }), e("2026-10-08T10:00:02Z", "error", { message: "provider overloaded" })];
  assert.deepEqual(chatPreview(entries), { kind: "error", text: "Error: provider overloaded", ts: "2026-10-08T10:00:02Z" });
  assert.equal(chatPreview([e("2026-10-08T10:00:00Z", "user_message", { text: "hi" })]), null);
  assert.equal(chatPreview([]), null);
});

test("turnStartedAt is the first entry of the latest turn", () => {
  const entries = [
    e("2026-10-08T09:00:00Z", "user_message", { text: "a" }, "t0"),
    e("2026-10-08T09:01:00Z", "assistant_message", { text: "b" }, "t0"),
    e("2026-10-08T10:00:00Z", "user_message", { text: "c" }, "t1"),
    e("2026-10-08T10:02:00Z", "tool_call", {}, "t1"),
  ];
  assert.equal(turnStartedAt(entries), "2026-10-08T10:00:00Z");
  assert.equal(turnStartedAt([e("2026-10-08T10:00:00Z", "user_message", {}, null)]), null);
  const firstPrompt = [
    e("2026-10-08T09:59:58Z", "user_message", { text: "go" }, null),
    e("2026-10-08T10:00:01Z", "assistant_message", { text: "on it" }, "t1"),
  ];
  assert.equal(turnStartedAt(firstPrompt), "2026-10-08T09:59:58Z", "a first prompt without a turn id starts the turn");
  assert.equal(turnStartedAt([]), null);
});

test("dm preview names the recipient; the newer of chat and DM wins, ties to the chat", () => {
  const dm = dmPreview({ ts: "2026-10-08T11:00:00Z", to: "flint", subject: "can you check last night's run?" }, (p) => (p === "flint" ? "Flint" : p));
  assert.deepEqual(dm, { kind: "dm", text: "Messaged Flint: can you check last night's run?", ts: "2026-10-08T11:00:00Z" });
  const chat = { kind: "reply" as const, text: "x", ts: "2026-10-08T10:00:00Z" };
  assert.equal(latestPreview(chat, dm), dm);
  assert.equal(latestPreview({ ...chat, ts: "2026-10-08T12:00:00Z" }, dm)?.kind, "reply");
  assert.equal(latestPreview({ ...chat, ts: dm.ts }, dm)?.kind, "reply");
  assert.equal(latestPreview(null, dm), dm);
  assert.equal(latestPreview(chat, null), chat);
  assert.equal(latestPreview(null, null), null);
});

test("PreviewsService reads a chat once per activity stamp and retries failures", async () => {
  const service = new PreviewsService();
  let reads = 0;
  let fail = false;
  const fetchTail = async () => {
    reads++;
    if (fail) throw new Error("boom");
    return { entries: [e("2026-10-08T10:00:00Z", "assistant_message", { text: "hello" })] };
  };
  const chat = { id: "a1", lastActivityAt: "2026-10-08T10:00:00Z", updatedAt: "u1" };
  assert.equal((await service.forChat(chat, fetchTail)).preview?.text, "hello");
  await service.forChat(chat, fetchTail);
  assert.equal(reads, 1);
  fail = true;
  const next = { ...chat, lastActivityAt: "2026-10-08T10:05:00Z" };
  assert.equal((await service.forChat(next, fetchTail)).preview, null);
  await service.forChat(next, fetchTail);
  assert.equal(reads, 3, "a failed read is not cached");
  service.retain([]);
  fail = false;
  await service.forChat(chat, fetchTail);
  assert.equal(reads, 4, "retain drops chats that are gone");
});

test("a turn that fills the first window is read further back for its start", async () => {
  const turn = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => e(new Date(Date.parse("2026-10-08T10:00:00Z") + (from + i) * 1000).toISOString(), "tool_call", {}, "t9"));
  assert.equal(turnFillsWindow(turn(3, 0), true), true);
  assert.equal(turnFillsWindow(turn(3, 0), false), false);
  assert.equal(turnFillsWindow([e("2026-10-08T09:00:00Z", "user_message", {}, "t8"), ...turn(2, 0)], true), false);
  const limits: number[] = [];
  const service = new PreviewsService();
  const result = await service.forChat({ id: "c", lastActivityAt: "x" }, async (_id, limit) => {
    limits.push(limit);
    return limit === PREVIEW_TAIL_LONG ? { entries: turn(100, 0), hasOlder: false } : { entries: turn(40, 60), hasOlder: true };
  });
  assert.deepEqual(limits, [40, PREVIEW_TAIL_LONG]);
  assert.equal(result.turnStartedAt, "2026-10-08T10:00:00.000Z");
});

test("chatMessageAt: the newest prompt, reply or error; tool calls do not count", () => {
  const entry = (timestamp: string, type: string) => ({ timestamp, item: { type, text: "x" } });
  assert.equal(
    chatMessageAt([entry("2026-10-08T09:00:00Z", "user_message"), entry("2026-10-08T09:01:00Z", "assistant_message"), entry("2026-10-08T09:05:00Z", "tool_call")]),
    "2026-10-08T09:01:00Z",
  );
  assert.equal(chatMessageAt([entry("2026-10-08T09:00:00Z", "tool_call")]), null);
});

test("newestTime skips missing and bad times", () => {
  assert.equal(newestTime(null, "2026-10-08T09:00:00Z", "bad", "2026-10-08T10:00:00Z", undefined), "2026-10-08T10:00:00Z");
  assert.equal(newestTime(null, undefined), null);
});
