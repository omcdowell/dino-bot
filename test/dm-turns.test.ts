import { test } from "node:test";
import assert from "node:assert/strict";
import { DmTurnsService, dmOnlyUnread, isDmPrompt, type TimelineEntryLike } from "../server/dm-turns";

const DM = "[dm 01M4D5X7877ZFH3NTF21XFJJAC from emmet-brickowski to bitzer kind=request hop=1 re=- expects-reply]\nPlease check X.";
const REPORT = "[dm 01M4D5WGZMEC2MRS2C35MD93YT from worker:dm-wp4 to bitzer kind=report hop=1 re=-]\nDone.";
const USER = "how are crons working here in paseo?";

const at = (s: number) => new Date(Date.parse("2026-10-08T07:00:00.000Z") + s * 1000).toISOString();
const user = (s: number, turnId: string | null, text: string): TimelineEntryLike => ({ timestamp: at(s), turnId, item: { type: "user_message", text } });
const said = (s: number, turnId: string | null, text = "ok"): TimelineEntryLike => ({ timestamp: at(s), turnId, item: { type: "assistant_message", text } });

// History before the reload has no turn ids; then an Sam turn (t1) that he has read.
const history = [user(-600, null, "old prompt"), said(-600, null), user(-300, "t1", USER), said(-280, "t1")];

test("isDmPrompt: delivered DM and worker report envelopes only", () => {
  assert.equal(isDmPrompt(DM), true);
  assert.equal(isDmPrompt(REPORT), true);
  assert.equal(isDmPrompt(USER), false);
  assert.equal(isDmPrompt("re [dm 01M4D5X7877ZFH3NTF21XFJJAC from a to b kind=info hop=1 re=-]"), false);
  assert.equal(isDmPrompt(undefined), false);
});

test("a turn started by a DM, with the flag set at its end, is quiet", () => {
  const entries = [...history, user(0, "t2", DM), said(20, "t2")];
  assert.equal(dmOnlyUnread(entries, at(21)), true);
});

test("DMs steered into a DM turn keep it quiet; a worker report counts as a DM", () => {
  const entries = [...history, user(0, "t2", REPORT), said(5, "t2"), user(10, "t2", DM), said(20, "t2")];
  assert.equal(dmOnlyUnread(entries, at(21)), true);
});

test("a turn Sam started shows, even if DMs were steered into it", () => {
  assert.equal(dmOnlyUnread([...history, user(0, "t2", USER), said(20, "t2")], at(21)), false);
  assert.equal(dmOnlyUnread([...history, user(0, "t2", USER), said(5, "t2"), user(10, "t2", DM), said(20, "t2")], at(21)), false);
});

test("Sam steering into a DM turn makes it show", () => {
  assert.equal(dmOnlyUnread([...history, user(0, "t2", DM), said(5, "t2"), user(10, "t2", USER), said(20, "t2")], at(21)), false);
});

test("Sam's unread turn stays shown when a DM turn follows it", () => {
  // Sam's t2 set the flag at 21 s; he did not look; a DM turn t3 ran later.
  const entries = [...history, user(0, "t2", USER), said(20, "t2"), user(60, "t3", DM), said(80, "t3")];
  assert.equal(dmOnlyUnread(entries, at(21)), false);
});

test("a DM turn that set the flag, followed by an Sam turn, shows", () => {
  const entries = [...history, user(0, "t2", DM), said(20, "t2"), user(60, "t3", USER), said(80, "t3")];
  assert.equal(dmOnlyUnread(entries, at(21)), false);
});

test("an Sam turn that ran straight into the DM turn (no idle gap) counts", () => {
  const chained = [...history, user(0, "t2", USER), said(20, "t2"), user(21, "t3", DM), said(40, "t3")];
  assert.equal(dmOnlyUnread(chained, at(41)), false);
  // with a real gap, Sam's earlier turn was already read
  const apart = [...history, user(0, "t2", USER), said(20, "t2"), user(60, "t3", DM), said(80, "t3")];
  assert.equal(dmOnlyUnread(apart, at(81)), true);
});

test("uncertain cases show the dot: no flag, no turn ids, window may cut the turn off", () => {
  const entries = [...history, user(0, "t2", DM), said(20, "t2")];
  assert.equal(dmOnlyUnread(entries, null), false);
  assert.equal(dmOnlyUnread(entries, "not a date"), false);
  assert.equal(dmOnlyUnread([user(0, null, DM), said(20, null)], at(21)), false);
  assert.equal(dmOnlyUnread([user(0, "t2", DM), said(20, "t2")], at(21), true), false);
  assert.equal(dmOnlyUnread([user(0, "t2", DM), said(20, "t2")], at(21), false), true);
  assert.equal(dmOnlyUnread([said(0, "t2")], at(21)), false);
  assert.equal(dmOnlyUnread(entries, at(-1000)), false);
});

test("DmTurnsService: only finished flags, one timeline read per flag, errors show the dot", async () => {
  const svc = new DmTurnsService();
  const reads: string[] = [];
  const pages: Record<string, TimelineEntryLike[]> = {
    quiet: [...history, user(0, "t2", DM), said(20, "t2")],
    loud: [...history, user(0, "t2", USER), said(20, "t2")],
  };
  const fetchTail = async (id: string) => {
    reads.push(id);
    if (id === "broken") throw new Error("boom");
    return { entries: pages[id] ?? [], hasOlder: false };
  };
  const agents = [
    { id: "quiet", requiresAttention: true, attentionReason: "finished", attentionTimestamp: at(21) },
    { id: "loud", requiresAttention: true, attentionReason: "finished", attentionTimestamp: at(21) },
    { id: "perm", requiresAttention: true, attentionReason: "permission", attentionTimestamp: at(21) },
    { id: "err", requiresAttention: true, attentionReason: "error", attentionTimestamp: at(21) },
    { id: "read", requiresAttention: false, attentionReason: null, attentionTimestamp: null },
    { id: "broken", requiresAttention: true, attentionReason: "finished", attentionTimestamp: at(21) },
  ];
  assert.deepEqual(await svc.quiet(agents, fetchTail), ["quiet"]);
  assert.deepEqual(reads.sort(), ["broken", "loud", "quiet"]);
  // polling again with the same flags reads nothing
  assert.deepEqual(await svc.quiet(agents, fetchTail), ["quiet"]);
  assert.equal(reads.length, 3);
  // a new flag (Sam read it, then an Sam turn finished) is read afresh
  pages.quiet = [...pages.quiet!, user(100, "t3", USER), said(120, "t3")];
  const next = agents.map((a) => (a.id === "quiet" ? { ...a, attentionTimestamp: at(121) } : a));
  assert.deepEqual(await svc.quiet(next, fetchTail), []);
  assert.equal(reads.length, 4);
});
