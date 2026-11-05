import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityAt,
  botOrder,
  formatElapsed,
  holdOrder,
  homeOrder,
  recencyOf,
  rememberStatus,
  rowTime,
  runningSince,
  sinceShort,
  spokenSince,
  spokenElapsed,
} from "../client/home-format";

test("formatElapsed", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(-5), "0:00");
  assert.equal(formatElapsed(NaN), "0:00");
  assert.equal(formatElapsed(42_400), "0:42");
  assert.equal(formatElapsed(12 * 60_000 + 5_000), "12:05");
  assert.equal(formatElapsed(3_600_000 + 2 * 60_000 + 9_000), "1:02:09");
});

test("spokenElapsed", () => {
  assert.equal(spokenElapsed(10_000), "running under a minute");
  assert.equal(spokenElapsed(60_000), "running 1 minute");
  assert.equal(spokenElapsed(3 * 60_000), "running 3 minutes");
  assert.equal(spokenElapsed(62 * 60_000), "running 1 hour 2 minutes");
  assert.equal(spokenElapsed(120 * 60_000), "running 2 hours");
});

test("rowTime: today, yesterday, weekday, date", () => {
  const now = new Date(2026, 9, 8, 15, 7); // Thu 8 Oct 2026
  assert.equal(rowTime(new Date(2026, 9, 8, 14, 52).toISOString(), now), "14:52");
  assert.equal(rowTime(new Date(2026, 9, 7, 9, 0).toISOString(), now), "Yesterday");
  assert.equal(rowTime(new Date(2026, 9, 3, 9, 0).toISOString(), now), "Saturday");
  assert.equal(rowTime(new Date(2026, 8, 20, 9, 0).toISOString(), now), "20 Sep");
  assert.equal(rowTime(new Date(2025, 8, 20, 9, 0).toISOString(), now), "20 Sep 2025");
  assert.equal(rowTime(null, now), "");
  assert.equal(rowTime("nope", now), "");
});

test("homeOrder: featured on top, rest by recent activity, then order and name", () => {
  const bot = (id: string, order = 10, featured = false) => ({ id, name: id, order, featured });
  const bots = [bot("fc", 0, true), bot("emmet"), bot("flint"), bot("bitzer"), bot("scrat", 5)];
  const at: Record<string, string | null> = {
    fc: "2026-10-08T15:00:00Z",
    emmet: "2026-10-08T14:31:00Z",
    flint: "2026-10-08T14:52:00Z",
    bitzer: null,
    scrat: null,
  };
  const { featured, rest } = homeOrder(bots, (b) => at[b.id]);
  assert.equal(featured?.id, "fc");
  assert.deepEqual(rest.map((b) => b.id), ["flint", "emmet", "scrat", "bitzer"]);
  assert.equal(homeOrder([bot("a")], () => null).featured, null);
});

test("runningSince prefers the server's turn start only when fetched after the switch to working", () => {
  const seen = Date.parse("2026-10-08T10:05:00Z");
  const server = "2026-10-08T10:00:00Z";
  assert.equal(runningSince(server, seen + 1000, seen), Date.parse(server));
  assert.equal(runningSince(server, seen - 1000, seen), seen, "older answer may describe the previous turn");
  assert.equal(runningSince(null, seen + 1000, seen), seen);
  assert.equal(runningSince("2026-10-08T10:10:00Z", seen + 1000, seen), seen + 1000, "never in the future of the fetch");
});

test("homeOrder: the featured bot stays pinned on top even when it is the oldest", () => {
  const bot = (id: string, order = 10, featured = false) => ({ id, name: id, order, featured });
  const bots = [bot("the-fat-controller", 0, true), bot("tweety-bird"), bot("emmet-brickowski"), bot("scrat")];
  const at: Record<string, string> = {
    "the-fat-controller": "2026-10-08T01:00:00Z",
    "tweety-bird": "2026-10-08T06:58:00Z",
    "emmet-brickowski": "2026-10-08T16:35:00Z",
    scrat: "2026-10-08T16:23:00Z",
  };
  const { featured, rest } = homeOrder(bots, (b) => at[b.id]);
  assert.equal(featured?.id, "the-fat-controller");
  assert.deepEqual(rest.map((b) => b.id), ["emmet-brickowski", "scrat", "tweety-bird"]);
});

test("activityAt: the server's last activity, else the preview's time", () => {
  assert.equal(activityAt({ activityAt: "2026-10-08T10:00:00Z", preview: { ts: "2026-10-08T09:00:00Z" } }), "2026-10-08T10:00:00Z");
  assert.equal(activityAt({ preview: { ts: "2026-10-08T09:00:00Z" } }), "2026-10-08T09:00:00Z");
  assert.equal(activityAt(undefined), null);
});

test("rememberStatus keeps last live statuses; none and read drop the entry; same status keeps the object", () => {
  const a = rememberStatus({}, "flint", "unread", 1);
  assert.deepEqual(a, { flint: { status: "unread", at: 1 } });
  assert.equal(rememberStatus(a, "flint", "unread", 2), a);
  assert.deepEqual(rememberStatus(a, "flint", "working", 3), { flint: { status: "working", at: 3 } });
  assert.deepEqual(rememberStatus(a, "flint", "read", 4), {});
  const empty = {};
  assert.equal(rememberStatus(empty, "scrat", "none", 5), empty);
});

const sbot = (id: string, order: number, featured = false) => ({ id, name: id, order, featured });

test("recencyOf: the server's activity first, the agent's own time only when the server has none", () => {
  const rows = new Map([
    ["a", { activityAt: "2026-10-10T10:00:00Z", preview: null }],
    ["b", { activityAt: null, preview: { ts: "2026-10-10T09:00:00Z" } }],
  ]);
  const agentAt = new Map([
    ["a", "2026-10-10T12:00:00Z"],
    ["c", "2026-10-10T08:00:00Z"],
  ]);
  const of = recencyOf(rows, agentAt);
  assert.equal(of(sbot("a", 0)), "2026-10-10T10:00:00Z");
  assert.equal(of(sbot("b", 0)), "2026-10-10T09:00:00Z");
  assert.equal(of(sbot("c", 0)), "2026-10-10T08:00:00Z");
  assert.equal(of(sbot("d", 0)), null);
});

test("botOrder: the sidebar's flat list, same order as the phone home (featured pinned first)", () => {
  const bots = [sbot("old", 0), sbot("fc", 1, true), sbot("new", 2), sbot("none", 3)];
  const rows = new Map([
    ["old", { activityAt: "2026-10-10T08:00:00Z" }],
    ["fc", { activityAt: "2026-10-01T08:00:00Z" }],
    ["new", { activityAt: "2026-10-10T11:00:00Z" }],
  ]);
  const ids = (list: { id: string }[]) => list.map((b) => b.id);
  assert.deepEqual(ids(botOrder(bots, recencyOf(rows, new Map()))), ["fc", "new", "old", "none"]);
  const { featured, rest } = homeOrder(bots, recencyOf(rows, new Map()));
  assert.deepEqual(ids(botOrder(bots, recencyOf(rows, new Map()))), ids([featured!, ...rest]));
  // No featured bot: just the recency order.
  assert.deepEqual(ids(botOrder(bots.filter((b) => !b.featured), recencyOf(rows, new Map()))), ["new", "old", "none"]);
});

test("holdOrder: keeps the order on screen, drops gone bots, appends new ones", () => {
  assert.deepEqual(holdOrder(null, ["a", "b"]), ["a", "b"]);
  assert.deepEqual(holdOrder(["a", "b", "c"], ["c", "a", "b"]), ["a", "b", "c"]);
  assert.deepEqual(holdOrder(["a", "b", "c"], ["c", "a"]), ["a", "c"]);
  assert.deepEqual(holdOrder(["a", "b"], ["d", "b", "a"]), ["a", "b", "d"]);
});

test("sinceShort: now, minutes, hours, weekday, date", () => {
  const now = new Date(2026, 9, 10, 15, 7, 30); // Sat 10 Oct 2026
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(sinceShort(ago(0), now), "now");
  assert.equal(sinceShort(ago(59_999), now), "now");
  assert.equal(sinceShort(ago(60_000), now), "1m");
  assert.equal(sinceShort(ago(4 * 60_000 + 30_000), now), "4m");
  assert.equal(sinceShort(ago(59 * 60_000 + 59_000), now), "59m");
  assert.equal(sinceShort(ago(60 * 60_000), now), "1h");
  assert.equal(sinceShort(ago(2 * 3_600_000 + 59 * 60_000), now), "2h");
  assert.equal(sinceShort(ago(23 * 3_600_000 + 59 * 60_000), now), "23h");
  assert.equal(sinceShort(ago(24 * 3_600_000), now), "Fri");
  assert.equal(sinceShort(new Date(2026, 9, 6, 9, 0).toISOString(), now), "Tue");
  assert.equal(sinceShort(new Date(2026, 9, 4, 0, 0).toISOString(), now), "Sun", "six calendar days back");
  assert.equal(sinceShort(new Date(2026, 9, 3, 23, 59).toISOString(), now), "3 Oct", "a week back is a date");
  assert.equal(sinceShort(new Date(2026, 0, 1, 9, 0).toISOString(), now), "1 Jan");
  assert.equal(sinceShort(new Date(2025, 9, 3, 9, 0).toISOString(), now), "Oct 2025");
});

test("sinceShort: no activity shows nothing, future or clock skew reads now", () => {
  const now = new Date(2026, 9, 10, 15, 7);
  assert.equal(sinceShort(null, now), "");
  assert.equal(sinceShort(undefined, now), "");
  assert.equal(sinceShort("", now), "");
  assert.equal(sinceShort("nope", now), "");
  assert.equal(sinceShort(new Date(now.getTime() + 5_000).toISOString(), now), "now");
  assert.equal(sinceShort(new Date(now.getTime() + 3 * 3_600_000).toISOString(), now), "now");
  assert.equal(sinceShort(new Date().toISOString()), "now", "defaults to the current time");
});

test("spokenSince", () => {
  const now = new Date(2026, 9, 10, 15, 7);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(spokenSince(null, now), "");
  assert.equal(spokenSince(ago(10_000), now), "last used just now");
  assert.equal(spokenSince(ago(-10_000), now), "last used just now");
  assert.equal(spokenSince(ago(60_000), now), "last used 1 minute ago");
  assert.equal(spokenSince(ago(4 * 60_000), now), "last used 4 minutes ago");
  assert.equal(spokenSince(ago(3_600_000), now), "last used 1 hour ago");
  assert.equal(spokenSince(ago(5 * 3_600_000), now), "last used 5 hours ago");
  assert.equal(spokenSince(new Date(2026, 9, 6, 9, 0).toISOString(), now), "last used Tuesday");
  assert.equal(spokenSince(new Date(2026, 8, 20, 9, 0).toISOString(), now), "last used 20 Sep");
});
