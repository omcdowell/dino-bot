import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deliverable, parseMentions, replyHop, route, utf8Bytes } from "../shared/rooms/router";
import {
  ASSIGN_REFUSAL_REASONS,
  HOP_CAP,
  LEAD_ASSIGN_CAP,
  LEAD_ASSIGN_WINDOW_MS,
  RATE_CAP,
  DIGEST_MAX_BYTES,
  DIGEST_MAX_MSGS,
  GroupSchema,
  GroupsFileSchema,
  RouterStateSchema,
  emptyRouterState,
  type Group,
  type RoomMessage,
  type RouterState,
} from "../shared/rooms/schema";
import { setUserName } from "../shared/party";

// Prompts and notices name the user from the settings; these tests use a configured name.
setUserName("Sam");

const G: Group = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], leads: ["wallace"] };
/** Two leads: wallace and peggy hear every message from Sam; scrat only when named. */
const G2: Group = { ...G, leads: ["wallace", "peggy"] };
const NAMES: Record<string, string> = {
  wallace: "Wallace",
  scrat: "Scrat",
  peggy: "Peggy Olson",
  "emmet-brickowski": "Emmet Brickowski",
};
const T0 = Date.UTC(2026, 9, 13, 0, 0, 0);

let n = 0;
function msg(from: string, text: string, hop = 0, id?: string): RoomMessage {
  n++;
  return { v: 1, id: id ?? `01M${String(n).padStart(23, "0")}`, ts: new Date(T0 + n * 1000).toISOString(), group: G.id, from, text, hop, to: [] };
}
const pm = (text: string) => parseMentions(text, G, NAMES);

// ---------- parseMentions ----------

test("mentions: ids, display first names, case-insensitive, punctuation", () => {
  assert.deepEqual(pm("@wallace, can you check?").bots, ["wallace"]);
  assert.deepEqual(pm("ask @Peggy please").bots, ["peggy"]);
  assert.deepEqual(pm("@PEGGY @peggy @Wallace.").bots, ["peggy", "wallace"]);
  assert.deepEqual(pm("(@scrat) and @wallace: hi").bots, ["scrat", "wallace"]);
  assert.deepEqual(pm("@scrat's acorn").bots, ["scrat"]);
});

test("mentions: email and partial words are not mentions", () => {
  assert.deepEqual(pm("mail email@x.com or wallace@peggy.com").bots, []);
  assert.deepEqual(pm("@wallaces is not wallace").bots, []);
  assert.deepEqual(pm("@peg is not peggy").bots, []);
  assert.deepEqual(pm("no at sign wallace").bots, []);
});

test("mentions: @all / @everyone", () => {
  assert.equal(pm("@all hi").all, true);
  assert.equal(pm("hey @Everyone!").all, true);
  assert.equal(pm("@allison").all, false);
});

test("mentions: non-members ignored, known ones reported", () => {
  const m = pm("@emmet-brickowski and @Emmet and @nobody and @wallace");
  assert.deepEqual(m.bots, ["wallace"]);
  assert.deepEqual(m.nonMembers, ["emmet-brickowski"]);
  // without names, only ids resolve
  assert.deepEqual(parseMentions("@Peggy @peggy", G, {}).bots, ["peggy"]);
  assert.deepEqual(parseMentions("@Olson", G, NAMES).bots, []);
});

test("mentions: task syntax (§3.5)", () => {
  assert.deepEqual(pm("@wallace task: book the venue").tasked, ["wallace"]);
  assert.deepEqual(pm("@Wallace TASK: x").tasked, ["wallace"]);
  assert.deepEqual(pm("@wallace, task: x").tasked, ["wallace"]);
  assert.deepEqual(pm("@wallace task: a\n@scrat task: b").tasked, ["wallace", "scrat"]);
  assert.deepEqual(pm("@peggy\ntask: draft the copy").tasked, ["peggy"]);
  assert.equal(pm("@peggy @scrat\ntask: draft").task, false); // two named, line form is ambiguous
  assert.equal(pm("@all\ntask: draft").task, false);
  assert.equal(pm("@wallace what is the task: list?").task, false);
  assert.equal(pm("@wallace when is the launch?").task, false);
  assert.equal(pm("task: nobody named").task, false);
});

// ---------- route ----------

test("route: Sam with no name -> lead; with names -> those plus the lead; @all -> all", () => {
  const s = emptyRouterState();
  assert.deepEqual(route(G, msg("user", "hello"), s, T0, NAMES).to, ["wallace"]);
  assert.deepEqual(route(G, msg("user", "@Peggy @scrat hi"), s, T0, NAMES).to, ["peggy", "scrat", "wallace"]);
  assert.deepEqual(route(G, msg("user", "@wallace hi"), s, T0, NAMES).to, ["wallace"], "a named lead is not woken twice");
  assert.deepEqual(route(G, msg("user", "@all hi @scrat"), s, T0, NAMES).to, ["wallace", "scrat", "peggy"]);
  assert.deepEqual(route(G, msg("user", "@everyone"), s, T0, NAMES).to, ["wallace", "scrat", "peggy"]);
});

test("route: Sam naming only a non-member -> lead, with not_member refusal", () => {
  const r = route(G, msg("user", "@emmet-brickowski thoughts?"), emptyRouterState(), T0, NAMES);
  assert.deepEqual(r.to, ["wallace"]);
  assert.deepEqual(r.refused, [{ bot: "emmet-brickowski", reason: "not_member" }]);
  assert.deepEqual(r.message.refused, r.refused);
});

test("route: bot with no @name -> nobody; system -> nobody", () => {
  const s = emptyRouterState();
  const a = route(G, msg("scrat", "I think 3 Nov works", 1), s, T0, NAMES);
  assert.deepEqual(a.to, []);
  assert.equal(a.message.refused, undefined);
  assert.deepEqual(route(G, msg("system", "@wallace room paused: low memory"), s, T0, NAMES).to, []);
});

test("route: bot @name wakes named members except sender; @scrat from scrat is refused as self", () => {
  const r = route(G, msg("scrat", "@scrat note to self, @wallace see this", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(r.to, ["wallace"]);
  assert.deepEqual(r.refused, [{ bot: "scrat", reason: "self" }]);
  // @all from a bot: everyone but the sender, no self refusal
  const a = route(G, msg("scrat", "@all ping", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(a.to, ["wallace", "peggy"]);
  assert.deepEqual(a.refused, []);
});

test("route: hop cap stops bot wakes at hop 6; Sam is never hop-capped", () => {
  assert.equal(HOP_CAP, 6);
  assert.equal(RATE_CAP, 6);
  const s = emptyRouterState();
  assert.deepEqual(route(G, msg("wallace", "@scrat ?", 3), s, T0, NAMES).to, ["scrat"], "hop 3 passes now");
  assert.deepEqual(route(G, msg("wallace", "@scrat ?", 5), s, T0, NAMES).to, ["scrat"]);
  const r = route(G, msg("wallace", "@scrat ?", 6), s, T0, NAMES);
  assert.deepEqual(r.to, []);
  assert.deepEqual(r.refused, [{ bot: "scrat", reason: "hop_cap" }]);
  assert.deepEqual(route(G, msg("user", "@scrat ?", 9), s, T0, NAMES).to, ["scrat", "wallace"]);
});

test("route: rate cap 6 bot wakes per 10 min; Sam uncapped and not counted", () => {
  let s = emptyRouterState();
  for (let i = 0; i < 3; i++) s = route(G, msg("wallace", "@scrat @peggy", 1), s, T0 + i, NAMES).state;
  assert.equal(s.wakes.length, 6);
  const r = route(G, msg("peggy", "@wallace", 1), s, T0 + 10, NAMES);
  assert.deepEqual(r.refused, [{ bot: "wallace", reason: "rate_cap" }]);
  const o = route(G, msg("user", "@all go"), s, T0 + 11, NAMES);
  assert.deepEqual(o.to, ["wallace", "scrat", "peggy"]);
  assert.equal(o.state.wakes.length, 6);
  // window slides
  assert.deepEqual(route(G, msg("peggy", "@wallace", 1), s, T0 + 10 * 60 * 1000 + 1, NAMES).to, ["wallace"]);
});

test("route: assignment from Sam and the lead only; a member's task: stays room text (not_lead)", () => {
  const o = route(G, msg("user", "@wallace task: book it"), emptyRouterState(), T0, NAMES);
  assert.deepEqual(o.assign, ["wallace"]);
  assert.deepEqual(o.assignRefused, []);
  const b = route(G, msg("scrat", "@wallace task: book it", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(b.assign, []);
  assert.deepEqual(b.to, ["wallace"], "the mention still wakes wallace in the room");
  assert.deepEqual(b.assignRefused, [{ bot: "wallace", reason: "not_lead" }]);
  const l = route(G, msg("wallace", "@Peggy task: draft the copy", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(l.assign, ["peggy"]);
  assert.deepEqual(l.to, ["peggy"]);
  assert.deepEqual(l.assignRefused, []);
  assert.deepEqual(l.state.assigns, [T0]);
  // "task:" on its own line with exactly one member named, as for Sam.
  assert.deepEqual(route(G, msg("wallace", "@scrat\ntask: count acorns", 1), emptyRouterState(), T0, NAMES).assign, ["scrat"]);
  // Plain mentions from the lead are not tasks.
  assert.deepEqual(route(G, msg("wallace", "@scrat what do you think?", 1), emptyRouterState(), T0, NAMES).assign, []);
});

test("route: Sam's Assign toggle (msg.task) makes every @named member a task, without task:", () => {
  const one = route(G, { ...msg("user", "@peggy draft the copy"), task: true }, emptyRouterState(), T0, NAMES);
  assert.deepEqual([one.to, one.assign], [["peggy", "wallace"], ["peggy"]]);
  assert.equal(one.message.task, true, "kept on the ledger line");
  const two = route(G, { ...msg("user", "@Peggy and @scrat, sort the launch"), task: true }, emptyRouterState(), T0, NAMES);
  assert.deepEqual(two.assign, ["peggy", "scrat"]);
  const mixed = route(G, { ...msg("user", "@scrat task: count\n@peggy help him"), task: true }, emptyRouterState(), T0, NAMES);
  assert.deepEqual(mixed.assign, ["scrat", "peggy"], "task: and toggle together, no duplicates");
  // No member named (the client hides the toggle): no task, not even to the lead; @all is never a task.
  assert.deepEqual(route(G, { ...msg("user", "launch?"), task: true }, emptyRouterState(), T0, NAMES).assign, []);
  assert.deepEqual(route(G, { ...msg("user", "@all review"), task: true }, emptyRouterState(), T0, NAMES).assign, []);
  // Off: plain mention stays room talk; task: still works.
  assert.deepEqual(route(G, msg("user", "@peggy draft the copy"), emptyRouterState(), T0, NAMES).assign, []);
  assert.deepEqual(route(G, msg("user", "@peggy task: draft"), emptyRouterState(), T0, NAMES).assign, ["peggy"]);
  // A bot's message cannot carry the flag into an assignment.
  assert.deepEqual(route(G, { ...msg("scrat", "@peggy go", 1), task: true }, emptyRouterState(), T0, NAMES).assign, []);
});

test("route: the lead cannot assign to itself, to non-members or to @all", () => {
  const self = route(G, msg("wallace", "@wallace task: remind me", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(self.assign, []);
  assert.deepEqual(self.assignRefused, [{ bot: "wallace", reason: "self" }]);
  const outside = route(G, msg("wallace", "@emmet-brickowski task: ship it", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(outside.assign, []);
  assert.deepEqual(outside.assignRefused, [{ bot: "emmet-brickowski", reason: "not_member" }]);
  const all = route(G, msg("wallace", "@all task: everyone review", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(all.assign, []);
  assert.deepEqual(all.to, ["scrat", "peggy"], "@all still wakes the room");
  assert.deepEqual(all.assignRefused, [{ bot: "all", reason: "all" }]);
  const everyone = route(G, msg("wallace", "@everyone task: x", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(everyone.assignRefused, [{ bot: "all", reason: "all" }]);
  // Sam's @all task: assigns nobody either (unchanged), and reports nothing.
  const oAll = route(G, msg("user", "@all task: x"), emptyRouterState(), T0, NAMES);
  assert.deepEqual([oAll.assign, oAll.assignRefused], [[], []]);
  // Mixed: one good, one bad.
  const mixed = route(G, msg("wallace", "@scrat task: a\n@wallace task: b", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(mixed.assign, ["scrat"]);
  assert.deepEqual(mixed.assignRefused, [{ bot: "wallace", reason: "self" }]);
});

test("route: a lead task goes only to a member the reply woke (hop and rate caps first)", () => {
  const hop = route(G, msg("wallace", "@scrat task: a", HOP_CAP), emptyRouterState(), T0, NAMES);
  assert.deepEqual([hop.to, hop.assign], [[], []]);
  assert.deepEqual(hop.assignRefused, [{ bot: "scrat", reason: "hop_cap" }]);
  const full = { ...emptyRouterState(), wakes: Array.from({ length: RATE_CAP }, (_, i) => T0 - i) };
  const rate = route(G, msg("wallace", "@scrat task: a", 1), full, T0, NAMES);
  assert.deepEqual([rate.to, rate.assign], [[], []]);
  assert.deepEqual(rate.assignRefused, [{ bot: "scrat", reason: "rate_cap" }]);
  assert.equal(rate.state.assigns, undefined, "nothing counted");
});

test("route: at most LEAD_ASSIGN_CAP lead tasks per group per 10 min; the window slides; Sam not counted", () => {
  assert.equal(LEAD_ASSIGN_CAP, 3);
  let s = emptyRouterState();
  s = route(G, msg("wallace", "@scrat task: a\n@peggy task: b", 1), s, T0, NAMES).state;
  s = route(G, msg("user", "@peggy task: c"), s, T0 + 1, NAMES).state;
  assert.deepEqual(s.assigns, [T0, T0]);
  const third = route(G, msg("wallace", "@scrat task: d\n@peggy task: e", 1), s, T0 + 2, NAMES);
  assert.deepEqual(third.assign, ["scrat"]);
  assert.deepEqual(third.assignRefused, [{ bot: "peggy", reason: "assign_cap" }]);
  assert.deepEqual(third.to, ["scrat", "peggy"], "the room wake is not part of the task cap");
  s = third.state;
  assert.equal(s.assigns!.length, 3);
  assert.deepEqual(route(G, msg("wallace", "@peggy task: f", 1), s, T0 + LEAD_ASSIGN_WINDOW_MS - 1, NAMES).assignRefused, [
    { bot: "peggy", reason: "assign_cap" },
  ]);
  const later = route(G, msg("wallace", "@peggy task: f", 1), s, T0 + LEAD_ASSIGN_WINDOW_MS, NAMES);
  assert.deepEqual(later.assign, ["peggy"], "the first two fell out of the window");
  assert.equal(RouterStateSchema.safeParse(later.state).success, true);
  // State written before lead assignments (no `assigns`) still routes, and stays without the field for others.
  const old = route(G, msg("scrat", "@peggy hi", 1), emptyRouterState(), T0, NAMES);
  assert.equal("assigns" in old.state, false);
  assert.ok(ASSIGN_REFUSAL_REASONS.includes("assign_cap"));
});

test("mentions: every member in a run of mentions before task: is tasked (gc-final)", () => {
  // Space, comma, "and" (and "&", Oxford comma) separate the names of one run; runs of 2 and 3.
  for (const t of ["@scrat @peggy task: x", "@scrat, @peggy task: x", "@scrat and @peggy task: x", "@Scrat & @Peggy: task: x"]) {
    assert.deepEqual(pm(t).tasked, ["scrat", "peggy"], t);
  }
  for (const t of ["@wallace @scrat @peggy task: x", "@wallace, @scrat, @peggy task: x", "@wallace, @scrat and @peggy task: x", "@wallace, @scrat, and @peggy task: x"]) {
    assert.deepEqual(pm(t).tasked, ["wallace", "scrat", "peggy"], t);
  }
  // Mid-line, and one run per part.
  assert.deepEqual(pm("Today: @scrat and @peggy task: copy @wallace task: date").tasked, ["scrat", "peggy", "wallace"]);
  // Other words break the run: only the names right before task: are tasked.
  assert.deepEqual(pm("@scrat said @peggy task: x").tasked, ["peggy"]);
  assert.deepEqual(pm("@scrat and then @peggy task: x").tasked, ["peggy"]);
  assert.deepEqual(pm("@scrat @peggy\ntask: x").tasked, [], "the line form is still for one named member only");
  // A non-member or @all in the run is reported as before; the members in it are still tasked.
  const outside = pm("@scrat @emmet task: x");
  assert.deepEqual([outside.tasked, outside.taskedNonMembers], [["scrat"], ["emmet-brickowski"]]);
  const all = pm("@all @scrat task: x");
  assert.deepEqual([all.taskAll, all.tasked], [true, ["scrat"]]);
  // No task: the run is just a mention, as before.
  assert.equal(pm("@Scrat and @Peggy: launch Friday").task, false);
});

test("route: a part that tasks N members counts as N lead tasks against LEAD_ASSIGN_CAP (gc-final)", () => {
  const sam = route(G, msg("user", "@scrat, @peggy and @wallace task: x"), emptyRouterState(), T0, NAMES);
  assert.deepEqual(sam.assign, ["scrat", "peggy", "wallace"]);
  let s = emptyRouterState();
  const two = route(G, msg("wallace", "@scrat and @peggy task: a", 1), s, T0, NAMES);
  assert.deepEqual(two.assign, ["scrat", "peggy"]);
  assert.deepEqual(two.state.assigns, [T0, T0]);
  s = two.state;
  const next = route(G, msg("wallace", "@scrat @peggy task: b", 1), s, T0 + 1, NAMES);
  assert.deepEqual(next.assign, ["scrat"]);
  assert.deepEqual(next.assignRefused, [{ bot: "peggy", reason: "assign_cap" }]);
});

test("route: does not mutate its inputs; message carries to; state is valid JSON schema", () => {
  const s = emptyRouterState();
  const before = JSON.stringify(s);
  const m = msg("user", "@peggy hi");
  const mBefore = JSON.stringify(m);
  const r = route(G, m, s, T0, NAMES);
  assert.equal(JSON.stringify(s), before);
  assert.equal(JSON.stringify(m), mBefore);
  assert.deepEqual(r.message.to, ["peggy", "wallace"]);
  assert.deepEqual(r.state.queues, { peggy: [m.id], wallace: [m.id] });
  RouterStateSchema.parse(JSON.parse(JSON.stringify(r.state)));
});

// ---------- deliverable ----------

test("deliverable: busy holds the queue; idle drains one digest, then empty", () => {
  let s = emptyRouterState();
  const a = msg("user", "@wallace when is the launch?");
  const b = msg("scrat", "@wallace I need the date too.", 1);
  s = route(G, a, s, T0, NAMES).state;
  s = route(G, b, s, T0 + 1, NAMES).state;
  const busy = deliverable(s, "wallace", true);
  assert.deepEqual(busy.digest, []);
  assert.equal(busy.state, s);
  const d = deliverable(s, "wallace", false);
  assert.deepEqual(d.digest.map((m) => m.id), [a.id, b.id]);
  assert.equal(d.state.queues.wallace, undefined);
  assert.deepEqual(deliverable(d.state, "wallace", false).digest, []);
  assert.equal(replyHop(d.digest, "wallace"), 2);
});

test("deliverable: nothing queued -> nothing, even with unseen context", () => {
  let s = emptyRouterState();
  s = route(G, msg("user", "@wallace hi"), s, T0, NAMES).state;
  assert.deepEqual(deliverable(s, "peggy", false).digest, []);
});

test("deliverable: context lines included, own lines excluded, replyHop counts only addressed lines", () => {
  let s = emptyRouterState();
  const own = msg("peggy", "@scrat copy is late", 2);
  const ctx = msg("scrat", "@peggy ok", 2);
  const ask = msg("user", "@peggy status?");
  s = route(G, own, s, T0, NAMES).state;
  s = route(G, ctx, s, T0, NAMES).state;
  s = route(G, ask, s, T0, NAMES).state;
  s = deliverable(s, "scrat", false).state;
  const d = deliverable(s, "peggy", false);
  assert.deepEqual(d.digest.map((m) => m.id), [ctx.id, ask.id]);
  // ctx was addressed to peggy (hop 2), so reply hop 3
  assert.equal(replyHop(d.digest, "peggy"), 3);
  // overheard hop-2 talk between others does not raise peggy's reply hop
  assert.equal(replyHop([{ ...ctx, to: ["wallace"] }, { ...ask, to: ["peggy"] }], "peggy"), 1);
});

test("deliverable: max 20 messages with a '…n earlier' line, oldest first", () => {
  let s = emptyRouterState();
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const m = msg("user", `@scrat line ${i}`);
    ids.push(m.id);
    s = route(G, m, s, T0 + i, NAMES).state;
  }
  const d = deliverable(s, "scrat", false);
  assert.equal(d.digest.length, DIGEST_MAX_MSGS);
  assert.equal(d.digest[0].from, "system");
  assert.equal(d.digest[0].text, "…11 earlier");
  assert.deepEqual(d.digest.slice(1).map((m) => m.id), ids.slice(11));
});

test("deliverable: exactly 20 fit without a cut line", () => {
  let s = emptyRouterState();
  for (let i = 0; i < 20; i++) s = route(G, msg("user", `@scrat ${i}`), s, T0, NAMES).state;
  const d = deliverable(s, "scrat", false);
  assert.equal(d.digest.length, 20);
  assert.ok(d.digest.every((m) => m.from === "user"));
});

test("deliverable: 8 KB cap keeps addressed lines before context", () => {
  let s = emptyRouterState();
  const big = "x".repeat(5000);
  const ask = msg("user", "@peggy short question");
  s = route(G, msg("scrat", `${big} a`, 1), s, T0, NAMES).state;
  s = route(G, ask, s, T0, NAMES).state;
  s = route(G, msg("wallace", `${big} b`, 1), s, T0, NAMES).state;
  s = route(G, msg("scrat", `${big} c`, 1), s, T0, NAMES).state;
  const d = deliverable(s, "peggy", false);
  const body = d.digest.filter((m) => m.from !== "system");
  const bytes = body.reduce((a, m) => a + utf8Bytes(m.text) + utf8Bytes(m.from) + 40, 0);
  assert.ok(bytes <= DIGEST_MAX_BYTES, `bytes ${bytes}`);
  assert.ok(body.some((m) => m.id === ask.id));
  assert.equal(d.digest[0].text, "…2 earlier");
  assert.deepEqual(body.map((m) => m.text.slice(-1)), ["n", "c"]);
});

test("deliverable: one oversized addressed message is clipped, not dropped", () => {
  let s = emptyRouterState();
  const m = msg("user", `@wallace ${"é".repeat(9000)}`);
  s = route(G, m, s, T0, NAMES).state;
  const d = deliverable(s, "wallace", false);
  assert.equal(d.digest.length, 1);
  assert.ok(d.digest[0].text.endsWith("…"));
  assert.ok(utf8Bytes(d.digest[0].text) <= DIGEST_MAX_BYTES);
});

test("utf8Bytes matches Buffer", () => {
  for (const s of ["", "abc", "é", "日本", "🦊x", "a\u{10348}b"]) assert.equal(utf8Bytes(s), Buffer.byteLength(s), s);
});

// ---------- determinism ----------

test("determinism: same inputs give identical outputs", () => {
  const run = () => {
    let s = emptyRouterState();
    const out: unknown[] = [];
    const msgs: RoomMessage[] = [
      { v: 1, id: "A", ts: "t", group: G.id, from: "user", text: "@all hi", hop: 0, to: [] },
      { v: 1, id: "B", ts: "t", group: G.id, from: "scrat", text: "@peggy @wallace yo", hop: 1, to: [] },
      { v: 1, id: "C", ts: "t", group: G.id, from: "peggy", text: "@scrat back", hop: 2, to: [] },
    ];
    for (const m of msgs) {
      const r = route(G, m, s, T0, NAMES);
      s = r.state;
      out.push(r);
      const d = deliverable(s, "wallace", false);
      s = d.state;
      out.push(d.digest);
    }
    return JSON.stringify(out);
  };
  assert.equal(run(), run());
});

// ---------- several leads ----------

test("multi-lead: Sam with no name wakes every lead (not the non-lead)", () => {
  const r = route(G2, msg("user", "where are we on the launch?"), emptyRouterState(), T0, NAMES);
  assert.deepEqual(r.to, ["wallace", "peggy"]);
  assert.deepEqual(r.state.queues, { wallace: [r.message.id], peggy: [r.message.id] });
  assert.equal(r.state.wakes.length, 0, "Sam's wakes are not counted against the rate cap");
});

test("multi-lead: Sam @non-lead wakes that bot and every lead; @lead wakes all leads once; @all everyone", () => {
  const s = emptyRouterState();
  assert.deepEqual(route(G2, msg("user", "@scrat date?"), s, T0, NAMES).to, ["scrat", "wallace", "peggy"]);
  assert.deepEqual(route(G2, msg("user", "@Peggy copy?"), s, T0, NAMES).to, ["peggy", "wallace"]);
  assert.deepEqual(route(G2, msg("user", "@all go"), s, T0, NAMES).to, ["wallace", "scrat", "peggy"]);
  // Only a non-member named: still every lead, with the refusal.
  const out = route(G2, msg("user", "@emmet-brickowski?"), s, T0, NAMES);
  assert.deepEqual([out.to, out.refused], [["wallace", "peggy"], [{ bot: "emmet-brickowski", reason: "not_member" }]]);
  // Assign toggle: the task goes to the named member only, not to the leads woken by default.
  const t = route(G2, { ...msg("user", "@scrat count acorns"), task: true }, s, T0, NAMES);
  assert.deepEqual([t.to, t.assign], [["scrat", "wallace", "peggy"], ["scrat"]]);
});

test("multi-lead: a bot message with no @name wakes nobody, not even the leads", () => {
  const s = emptyRouterState();
  assert.deepEqual(route(G2, msg("scrat", "3 Nov works", 1), s, T0, NAMES).to, []);
  assert.deepEqual(route(G2, msg("wallace", "noted", 1), s, T0, NAMES).to, []);
  assert.deepEqual(route(G2, msg("system", "Scrat joined the group"), s, T0, NAMES).to, []);
});

test("multi-lead: a bot @lead wakes that lead under the hop and rate caps", () => {
  const s = emptyRouterState();
  const a = route(G2, msg("scrat", "@peggy copy status?", 1), s, T0, NAMES);
  assert.deepEqual(a.to, ["peggy"], "the other lead is not woken");
  assert.deepEqual(a.state.wakes, [T0]);
  const lead2lead = route(G2, msg("wallace", "@Peggy agree?", 2), s, T0, NAMES);
  assert.deepEqual(lead2lead.to, ["peggy"]);
  const hop = route(G2, msg("scrat", "@peggy ?", HOP_CAP), s, T0, NAMES);
  assert.deepEqual([hop.to, hop.refused], [[], [{ bot: "peggy", reason: "hop_cap" }]]);
  const full = { ...emptyRouterState(), wakes: Array.from({ length: RATE_CAP }, (_, i) => T0 - i) };
  const rate = route(G2, msg("scrat", "@wallace ?", 1), full, T0, NAMES);
  assert.deepEqual([rate.to, rate.refused], [[], [{ bot: "wallace", reason: "rate_cap" }]]);
});

test("multi-lead: both leads may assign; the non-lead may not; the cap is per room, shared by the leads", () => {
  let s = emptyRouterState();
  const w = route(G2, msg("wallace", "@scrat task: count acorns", 1), s, T0, NAMES);
  assert.deepEqual([w.assign, w.assignRefused], [["scrat"], []]);
  s = w.state;
  const p = route(G2, msg("peggy", "@wallace task: book the venue\n@scrat task: date", 1), s, T0 + 1, NAMES);
  assert.deepEqual([p.assign, p.assignRefused], [["wallace", "scrat"], []], "a lead may assign another lead");
  s = p.state;
  assert.deepEqual(s.assigns, [T0, T0 + 1, T0 + 1]);
  const capped = route(G2, msg("wallace", "@peggy task: copy", 1), s, T0 + 2, NAMES);
  assert.deepEqual([capped.assign, capped.assignRefused], [[], [{ bot: "peggy", reason: "assign_cap" }]]);
  const notLead = route(G2, msg("scrat", "@peggy task: copy", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual([notLead.to, notLead.assign, notLead.assignRefused], [["peggy"], [], [{ bot: "peggy", reason: "not_lead" }]]);
  const self = route(G2, msg("peggy", "@peggy task: remind me", 1), emptyRouterState(), T0, NAMES);
  assert.deepEqual(self.assignRefused, [{ bot: "peggy", reason: "self" }]);
});

// ---------- schema ----------

test("schema: groups file validation (§3.1)", () => {
  GroupsFileSchema.parse({ v: 1, groups: [G] });
  assert.equal(GroupSchema.safeParse({ ...G, leads: ["emmet"] }).success, false);
  assert.equal(GroupSchema.safeParse({ ...G, leads: [] }).success, false, "at least one lead");
  assert.equal(GroupSchema.safeParse({ ...G, leads: ["wallace", "wallace"] }).success, false);
  assert.equal(GroupSchema.safeParse(G2).success, true);
  assert.equal(GroupSchema.safeParse({ ...G, id: "Alarm Clock" }).success, false);
  assert.equal(GroupSchema.safeParse({ ...G, members: ["wallace"] }).success, false);
  assert.equal(GroupSchema.safeParse({ ...G, members: ["wallace", "wallace"] }).success, false);
  assert.equal(GroupsFileSchema.safeParse({ v: 1, groups: [G, G] }).success, false);
});

// ---------- recorded sequences ----------

type Ev =
  | { op: "route"; now: number; id: string; from: string; text: string; hop: number; expect: { to: string[]; refused: unknown[]; assign: string[] } }
  | { op: "deliver"; bot: string; busy: boolean; expect: { ids: string[] } };

const FIX = join(__dirname, "fixtures", "rooms");
for (const file of readdirSync(FIX).filter((f) => f.endsWith(".jsonl")).sort()) {
  test(`fixture ${file}`, () => {
    let s: RouterState = emptyRouterState();
    const lines = readFileSync(join(FIX, file), "utf8").split("\n").filter(Boolean);
    lines.forEach((line, i) => {
      const ev = JSON.parse(line) as Ev;
      if (ev.op === "route") {
        const m: RoomMessage = { v: 1, id: ev.id, ts: new Date(T0 + ev.now).toISOString(), group: G.id, from: ev.from, text: ev.text, hop: ev.hop, to: [] };
        const r = route(G, m, s, T0 + ev.now, NAMES);
        assert.deepEqual({ to: r.to, refused: r.refused, assign: r.assign }, ev.expect, `${file}:${i + 1}`);
        s = r.state;
      } else {
        const d = deliverable(s, ev.bot, ev.busy);
        assert.deepEqual(d.digest.map((m) => m.id), ev.expect.ids, `${file}:${i + 1}`);
        s = d.state;
      }
    });
  });
}
