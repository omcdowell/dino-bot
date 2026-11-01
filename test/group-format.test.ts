import { test } from "node:test";
import assert from "node:assert/strict";
import type { Group, RoomMessage } from "../shared/rooms/schema";
import type { RoomMemberState } from "../client/group-types";
import {
  activeMention,
  hasMarkdown,
  addableBots,
  applyMemberOp,
  removeBlocked,
  leadToggleBlocked,
  groupSubtitle,
  avatarStack,
  assignTargets,
  composerHint,
  composerPost,
  sendButton,
  deliveryLine,
  groupOrder,
  newestScrollOffset,
  insertMention,
  memberLine,
  memberStatus,
  mentionSpans,
  pickerRows,
  quietLine,
  segmentsText,
  splitPreview,
  threadItems,
  typingLine,
} from "../client/group-format";
import { mentionTokens, parseMentions } from "../client/group-mentions";

const group: Group = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], leads: ["wallace"] };
/** Wallace and Peggy lead; Scrat does not. */
const group2: Group = { ...group, leads: ["wallace", "peggy"] };
const names: Record<string, string> = { wallace: "Wallace", scrat: "Scrat", peggy: "Peggy Olson", flint: "Flint" };

let n = 0;
function msg(from: string, text: string, extra: Partial<RoomMessage> = {}): RoomMessage {
  n += 1;
  return {
    v: 1,
    id: `01M${String(n).padStart(4, "0")}`,
    ts: extra.ts ?? `2026-10-13T07:${String(n).padStart(2, "0")}:00Z`,
    group: "alarm-clock",
    from,
    text,
    hop: from === "user" ? 0 : 1,
    to: [],
    ...extra,
  };
}

const idle = (botId: string): RoomMemberState => ({ botId, state: "idle", queued: 0 });

// ---------- mentions (U1 parseMentions, as the UI uses it) ----------

test("parseMentions: ids, first names, @all, word bounds, non-members", () => {
  const plain = parseMentions("@wallace, when?", group, names);
  assert.deepEqual([plain.bots, plain.all, plain.task], [["wallace"], false, false]);
  assert.deepEqual(parseMentions("ask @Peggy and @SCRAT", group, names).bots, ["peggy", "scrat"]);
  assert.deepEqual(parseMentions("@flint hi", group, names).nonMembers, ["flint"]);
  assert.deepEqual(parseMentions("mail sam@x.com", group, names).bots, []);
  assert.deepEqual(parseMentions("@flint are you there", group, names).bots, []);
  assert.equal(parseMentions("@everyone hi", group, names).all, true);
  assert.equal(parseMentions("@all hi", group, names).all, true);
  assert.deepEqual(parseMentions("@wallaceville", group, names).bots, []);
});

test("parseMentions: task keyword", () => {
  assert.equal(parseMentions("@scrat task: unmute it", group, names).task, true);
  assert.equal(parseMentions("@scrat: Task: unmute it", group, names).task, true);
  assert.equal(parseMentions("@scrat\ntask: unmute it", group, names).task, true);
  assert.equal(parseMentions("@scrat unmute it", group, names).task, false);
  assert.equal(parseMentions("@scrat @peggy\ntask: both", group, names).task, false);
});

test("mentionTokens: same token rules as the router", () => {
  assert.deepEqual(
    mentionTokens("(@wallace- hi @scrat) a@peggy x.@peggy +@peggy @9lives").map((t) => t.word),
    ["wallace", "scrat", "9lives"],
  );
  // Every token the highlighter finds as a member, the router counts, and the other way round.
  for (const text of ["@scrat, @Peggy!", "mail a@scrat", "(@wallace)", "@peggy_ hi", "@scrat-task: x"]) {
    const spans = mentionSpans(text, group, names).filter((s) => s.strong).length;
    const parsed = parseMentions(text, group, names);
    assert.equal(spans, parsed.bots.length + (parsed.all ? 1 : 0), text);
  }
});

// ---------- composer hint ----------

test("composer hint: no name goes to the lead", () => {
  assert.equal(segmentsText(composerHint("", group, names)), "To Wallace (lead) · @name or @all for others");
  assert.equal(segmentsText(composerHint("did it fire?", group, names)), "To Wallace (lead) · add @name to wake others");
  assert.equal(segmentsText(composerHint("@", group, names, { picking: true })), "To Wallace (lead) · pick who to wake");
  assert.deepEqual(composerHint("", group, names)[1], { text: "Wallace", strong: true });
});

test("composer hint: named, task, several, all", () => {
  assert.equal(segmentsText(composerHint("@scrat also log it", group, names)), "To Scrat + Wallace (lead) · Assign or task: sends it to their main chat");
  assert.equal(segmentsText(composerHint("@scrat task: log it", group, names)), "To Scrat + Wallace (lead) · task goes to Scrat's main chat");
  assert.equal(segmentsText(composerHint("@peggy @wallace hi", group, names)), "To Wallace, Peggy Olson");
  assert.equal(segmentsText(composerHint("@all anything else?", group, names)), "To everyone (3)");
  assert.equal(segmentsText(composerHint("@Peggy hi", group, names)), "To Peggy Olson + Wallace (lead) · Assign or task: sends it to their main chat");
  assert.equal(segmentsText(composerHint("@wallace hi", group, names)), "To Wallace · Assign or task: sends it to their main chat");
  assert.equal(segmentsText(composerHint("@flint hi", group, names)), "To Wallace (lead) · Flint not in this group");
});

// ---------- delivery line ----------

test("delivery line comes from the router's to", () => {
  assert.equal(deliveryLine(msg("user", "alarm didn't go off", { to: ["wallace"] }), group, names), "Wallace (lead)");
  assert.equal(deliveryLine(msg("user", "@wallace hi", { to: ["wallace"] }), group, names), "Wallace");
  assert.equal(deliveryLine(msg("user", "@scrat hi", { to: ["scrat", "wallace"] }), group, names), "Scrat + Wallace (lead)");
  // Lines written before multi-lead (a named bot only) still read right.
  assert.equal(deliveryLine(msg("user", "@scrat hi", { to: ["scrat"] }), group, names), "Scrat");
  assert.equal(deliveryLine(msg("user", "@all hi", { to: ["peggy", "wallace", "scrat"] }), group, names), "Wallace, Scrat, Peggy Olson");
  assert.equal(deliveryLine(msg("user", "hi", { to: [] }), group, names), "Nobody");
});

// ---------- mention highlight ----------

test("mentionSpans highlights members and @all only", () => {
  assert.deepEqual(mentionSpans("@scrat unmute it, cc @flint", group, names), [
    { text: "@scrat", strong: true },
    { text: " unmute it, cc @flint" },
  ]);
  assert.deepEqual(mentionSpans("@all ok?", group, names)[0], { text: "@all", strong: true });
  assert.deepEqual(mentionSpans("", group, names), [{ text: "" }]);
});

// ---------- thread items ----------

test("thread: bubbles, header grouping, delivery", () => {
  const items = threadItems(
    [
      msg("user", "morning", { to: ["wallace"], ts: "2026-10-13T07:00:00Z" }),
      msg("wallace", "Morning.", { ts: "2026-10-13T07:02:00Z" }),
      msg("wallace", "Also the speaker was muted.", { ts: "2026-10-13T07:03:00Z" }),
      msg("wallace", "Later note.", { ts: "2026-10-13T07:10:00Z" }),
      msg("scrat", "Me too.", { ts: "2026-10-13T07:10:30Z" }),
    ],
    group,
    names,
  );
  assert.deepEqual(
    items.map((i) => (i.kind === "bot" ? `${i.kind}:${i.msg.from}:${i.header}` : i.kind)),
    ["user", "bot:wallace:true", "bot:wallace:false", "bot:wallace:true", "bot:scrat:true"],
  );
  const first = items[0]!;
  assert.equal(first.kind === "user" && first.delivery, "Wallace (lead)");
  // 2A: the avatar sits beside the last bubble of each run.
  assert.deepEqual(
    items.map((i) => (i.kind === "bot" ? i.tail : null)),
    [null, false, true, true, true],
  );
});

test("thread 2A: a marker or system line between two messages of one bot splits the run", () => {
  const items = threadItems(
    [
      msg("scrat", "On it.", { ts: "2026-10-13T07:03:00Z", assigned: { bot: "scrat", agentId: "a-1" } }),
      msg("scrat", "Also logging volume.", { ts: "2026-10-13T07:03:30Z" }),
      msg("scrat", "Done.", { ts: "2026-10-13T07:04:00Z" }),
    ],
    group,
    names,
  );
  assert.deepEqual(
    items.map((i) => (i.kind === "bot" ? `bot:${i.header}:${i.tail}` : i.kind)),
    ["bot:true:true", "handover", "bot:true:false", "bot:false:true"],
  );
});

test("thread: an Sam message breaks a bot run", () => {
  const items = threadItems(
    [
      msg("wallace", "a", { ts: "2026-10-13T07:00:00Z" }),
      msg("user", "b", { to: ["wallace"], ts: "2026-10-13T07:00:10Z" }),
      msg("wallace", "c", { ts: "2026-10-13T07:00:20Z" }),
    ],
    group,
    names,
  );
  assert.equal(items[2]!.kind === "bot" && items[2]!.header, true);
});

test("thread: one hand-over marker for assigned + U5 sent line", () => {
  const task = msg("user", "@scrat task: unmute it", { to: ["scrat"], assigned: { bot: "scrat", agentId: "agent-1" } });
  const items = threadItems([task, msg("system", "Sent to Scrat's main chat"), msg("scrat", "On it.")], group, names);
  assert.deepEqual(items.map((i) => i.kind), ["user", "handover", "bot"]);
  const marker = items[1]!;
  assert.equal(marker.kind === "handover" && marker.agentId, "agent-1");
  assert.equal(marker.kind === "handover" && marker.name, "Scrat");
});

test("thread: sent line alone is a marker; its display name resolves", () => {
  const items = threadItems(
    [msg("user", "@peggy task: copy", { to: ["peggy"] }), msg("system", "Sent to Peggy Olson's main chat")],
    group,
    names,
  );
  assert.deepEqual(items.map((i) => i.kind), ["user", "handover"]);
  assert.equal(items[1]!.kind === "handover" && items[1]!.bot, "peggy");
  assert.equal(items[1]!.kind === "handover" && items[1]!.agentId, null);
});

test("thread: a lead bot's task shows as a hand-over marker with the lead's name, like Sam's", () => {
  const lead = msg("wallace", "@Peggy task: draft the copy", { to: ["peggy"], hop: 1 });
  const sent = msg("system", "Sent to Peggy Olson's main chat (from Wallace)", { re: lead.id, assigned: { bot: "peggy", agentId: "agent-p" } });
  const items = threadItems([lead, sent, msg("peggy", "On it.")], group, names);
  assert.deepEqual(items.map((i) => i.kind), ["bot", "handover", "bot"]);
  const marker = items[1]!;
  assert.equal(marker.kind === "handover" && marker.bot, "peggy");
  assert.equal(marker.kind === "handover" && marker.from, "Wallace");
  assert.equal(marker.kind === "handover" && marker.agentId, "agent-p");
  // Sam's marker has no `from`.
  const sam = threadItems([msg("user", "@scrat task: x", { to: ["scrat"] }), msg("system", "Sent to Scrat's main chat")], group, names);
  assert.equal(sam[1]!.kind === "handover" && sam[1]!.from, undefined);
});

test("thread: system lines and refusals", () => {
  const items = threadItems(
    [
      msg("system", "Scrat could not answer (timeout)"),
      msg("system", "room paused: low memory"),
      msg("wallace", "@scrat over to you", { hop: 3, refused: [{ bot: "scrat", reason: "hop_cap" }, { bot: "wallace", reason: "self" }] }),
    ],
    group,
    names,
  );
  assert.deepEqual(
    items.map((i) => (i.kind === "system" ? `${i.icon}:${i.text}` : i.kind)),
    ["alert:Scrat could not answer (timeout)", "pause:room paused: low memory", "bot", "pause:Not passed to Scrat (too many bot hops)"],
  );
});

// ---------- members ----------

test("member status text", () => {
  assert.equal(memberStatus(undefined), "Idle");
  assert.equal(memberStatus(idle("x")), "Idle");
  assert.equal(memberStatus({ botId: "x", state: "room", queued: 0 }), "Replying in the room");
  assert.equal(memberStatus({ botId: "x", state: "main-busy", queued: 0 }), "Working in main chat");
  assert.equal(memberStatus({ botId: "x", state: "queued", queued: 2 }), "Working in main chat · 2 waiting");
});

test("typing line: only woken bots", () => {
  assert.equal(typingLine([idle("wallace"), { botId: "scrat", state: "main-busy", queued: 0 }], group, names), null);
  const line = typingLine(
    [
      { botId: "scrat", state: "queued", queued: 1 },
      { botId: "wallace", state: "room", queued: 0 },
      idle("peggy"),
    ],
    group,
    names,
  )!;
  assert.equal(line.first, "wallace");
  assert.equal(segmentsText(line.segments), "Wallace is typing · Scrat working in main chat");
  assert.deepEqual(line.segments[0], { text: "Wallace", strong: true });
  const two = typingLine([{ botId: "peggy", state: "room", queued: 0 }, { botId: "wallace", state: "room", queued: 0 }], group, names)!;
  assert.equal(segmentsText(two.segments), "Wallace, Peggy Olson are typing");
});

test("quiet line after the quiet period, never while someone is woken", () => {
  const messages = [msg("wallace", "done", { ts: "2026-10-13T07:15:00Z" })];
  const at = new Date("2026-10-13T07:15:00Z").getTime();
  assert.equal(quietLine(messages, [], at + 60_000), null);
  assert.match(quietLine(messages, [idle("wallace")], at + 16 * 60_000)!, /^Quiet since \d\d:\d\d · room sessions have closed$/);
  assert.equal(quietLine(messages, [{ botId: "wallace", state: "room", queued: 0 }], at + 16 * 60_000), null);
  assert.equal(quietLine([], [], at), null);
});

// ---------- @ picker ----------

test("activeMention / insertMention", () => {
  assert.deepEqual(activeMention("@"), { start: 0, query: "" });
  assert.deepEqual(activeMention("hi @sc"), { start: 3, query: "sc" });
  assert.equal(activeMention("sam@x"), null);
  assert.equal(activeMention("@scrat hi"), null);
  assert.deepEqual(activeMention("hi @sc there", 6), { start: 3, query: "sc" });
  assert.deepEqual(insertMention("hi @sc", { start: 3, query: "sc" }, "scrat"), { text: "hi @scrat ", cursor: 10 });
  assert.deepEqual(insertMention("hi @sc there", { start: 3, query: "sc" }, "scrat"), { text: "hi @scrat there", cursor: 9 });
});

test("picker rows: lead first, filter, @all last", () => {
  const states = [idle("wallace"), { botId: "scrat", state: "main-busy" as const, queued: 0 }, idle("peggy")];
  const all = pickerRows("", group, names, states);
  assert.deepEqual(all.map((r) => r.id), ["wallace", "scrat", "peggy", "all"]);
  assert.deepEqual(all[0], { kind: "member", id: "wallace", name: "Wallace", lead: true, status: "Idle", busy: false });
  assert.equal(all[1]!.kind === "member" && all[1]!.status, "Working in main chat");
  assert.deepEqual(pickerRows("sc", group, names, states).map((r) => r.id), ["scrat"]);
  assert.deepEqual(pickerRows("ol", group, names, states).map((r) => r.id), ["peggy"]);
  assert.deepEqual(pickerRows("ev", group, names, states).map((r) => r.id), ["all"]);
  assert.deepEqual(pickerRows("zz", group, names, states), []);
});

// ---------- rows ----------

test("splitPreview, avatarStack, groupOrder, memberLine", () => {
  assert.deepEqual(splitPreview("Wallace: 6:30 is set"), { sender: "Wallace", rest: "6:30 is set" });
  assert.deepEqual(splitPreview("no sender here"), { sender: null, rest: "no sender here" });
  assert.deepEqual(splitPreview(null), { sender: null, rest: "" });
  assert.deepEqual(avatarStack(group), ["scrat", "peggy", "wallace"]);
  assert.deepEqual(
    groupOrder([
      { name: "B", lastTs: null },
      { name: "A", lastTs: "2026-10-13T07:00:00Z" },
      { name: "C", lastTs: "2026-10-13T08:00:00Z" },
    ]).map((g) => g.name),
    ["C", "A", "B"],
  );
  assert.equal(memberLine({ ...group, leads: ["scrat"] }, names), "Scrat (lead), Wallace, Peggy Olson");
  assert.equal(memberLine(group2, names), "Wallace (lead), Peggy Olson (lead), Scrat");
  assert.deepEqual(avatarStack(group2), ["peggy", "scrat", "wallace"], "first lead in front, the other lead next");
});

test("thread: U4's sent line (assigned on the system line, re = Sam's id) is one marker", () => {
  const task = msg("user", "@scrat task: unmute it", { to: ["scrat"] });
  const sent = msg("system", "Sent to Scrat's main chat", { re: task.id, assigned: { bot: "scrat", agentId: "agent-9" } });
  const failed = msg("system", "Could not send the task to Peggy Olson's main chat (offline)", { re: task.id });
  const items = threadItems([task, sent, failed], group, names);
  assert.deepEqual(items.map((i) => i.kind), ["user", "handover", "system"]);
  assert.equal(items[1]!.kind === "handover" && items[1]!.agentId, "agent-9");
  assert.equal(items[2]!.kind === "system" && items[2]!.icon, "alert");
});

// ---------- members edit ----------


test("members edit: add, remove, toggle lead, and the limits", () => {
  const g = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], leads: ["wallace"] };
  assert.deepEqual(applyMemberOp(g, { kind: "add", bot: "flint" }), { members: ["wallace", "scrat", "peggy", "flint"], leads: ["wallace"] });
  assert.deepEqual(applyMemberOp(g, { kind: "add", bot: "scrat" }), { error: "Already a member." });
  assert.deepEqual(applyMemberOp(g, { kind: "remove", bot: "peggy" }), { members: ["wallace", "scrat"], leads: ["wallace"] });
  // The last lead can neither be removed nor have its lead toggled off.
  assert.deepEqual(applyMemberOp(g, { kind: "remove", bot: "wallace" }), { error: "Make someone else a lead first." });
  assert.deepEqual(applyMemberOp(g, { kind: "lead", bot: "wallace" }), { error: "A group needs at least one lead." });
  assert.equal(leadToggleBlocked(g, "wallace"), "A group needs at least one lead.");
  assert.equal(leadToggleBlocked(g, "peggy"), null);
  // Toggle on: a second lead, in member order.
  assert.deepEqual(applyMemberOp(g, { kind: "lead", bot: "peggy" }), { members: ["wallace", "scrat", "peggy"], leads: ["wallace", "peggy"] });
  assert.deepEqual(applyMemberOp(g, { kind: "lead", bot: "flint" }), { error: "Only a member can lead." });
  // With two leads, either can be toggled off or removed.
  const g2 = { ...g, leads: ["wallace", "peggy"] };
  assert.deepEqual(applyMemberOp(g2, { kind: "lead", bot: "wallace" }), { members: ["wallace", "scrat", "peggy"], leads: ["peggy"] });
  assert.deepEqual(applyMemberOp(g2, { kind: "remove", bot: "wallace" }), { members: ["scrat", "peggy"], leads: ["peggy"] });
  assert.equal(removeBlocked(g2, "peggy"), null);
  const two = { ...g, members: ["wallace", "scrat"] };
  assert.equal(removeBlocked(two, "scrat"), "A group needs at least 2 members.");
  const full = { ...g, members: ["a", "b", "c", "d", "e", "f", "g", "wallace"] };
  assert.deepEqual(applyMemberOp(full, { kind: "add", bot: "x" }), { error: "A group has at most 8 members." });
  assert.deepEqual(addableBots(full, [{ id: "x", name: "X" }]), []);
  const bots = [{ id: "scrat", name: "Scrat" }, { id: "the-fat-controller", name: "The Fat Controller" }, { id: "flint", name: "Flint" }];
  assert.deepEqual(addableBots(g, bots).map((b) => b.id), ["flint", "the-fat-controller"]);
});

test("Assign toggle: shown only when the draft @names a member; the hint and the post follow it", () => {
  assert.deepEqual(assignTargets("no names here", group, names), []);
  assert.deepEqual(assignTargets("@all hi", group, names), [], "@all alone: no toggle");
  assert.deepEqual(assignTargets("@flint hi", group, names), [], "non-member: no toggle");
  assert.deepEqual(assignTargets("@Peggy and @wallace", group, names), ["wallace", "peggy"], "group order");
  assert.deepEqual(assignTargets("@all and @scrat", group, names), ["scrat"]);

  assert.equal(segmentsText(composerHint("@peggy draft it", group, names, { assign: true })), "To Peggy Olson + Wallace (lead) · task goes to their main chat");
  assert.equal(segmentsText(composerHint("@peggy @scrat go", group, names, { assign: true })), "To Scrat, Peggy Olson + Wallace (lead) · task goes to their main chat");
  assert.equal(segmentsText(composerHint("hello", group, names, { assign: true })), "To Wallace (lead) · add @name to wake others", "no target: toggle ignored");

  // Send path: assign only when on and shown; text trimmed; empty draft sends nothing.
  assert.deepEqual(composerPost("  @peggy draft the copy  ", true, group, names), { text: "@peggy draft the copy", assign: true });
  assert.deepEqual(composerPost("@peggy draft the copy", false, group, names), { text: "@peggy draft the copy", assign: false });
  assert.deepEqual(composerPost("draft the copy", true, group, names), { text: "draft the copy", assign: false }, "toggle on but hidden");
  assert.deepEqual(composerPost("@all review", true, group, names), { text: "@all review", assign: false });
  assert.deepEqual(composerPost("@peggy task: draft", false, group, names), { text: "@peggy task: draft", assign: false }, "task: still works server-side");
  assert.equal(composerPost("   ", true, group, names), null);
});

test("newestScrollOffset: iOS header inset keeps a short thread's first line below header D", () => {
  // No inset (old apps, Android, web): scrollToEnd as before.
  assert.equal(newestScrollOffset({ contentHeight: 200, viewportHeight: 700, topInset: 0 }), null);
  // Taller than the view: scrollToEnd lands right.
  assert.equal(newestScrollOffset({ contentHeight: 1500, viewportHeight: 700, topInset: 100 }), null);
  assert.equal(newestScrollOffset({ contentHeight: 700, viewportHeight: 700, topInset: 100 }), null);
  // Short thread: rest at the top of the inset, not at 0 (which hid the first bubble).
  assert.equal(newestScrollOffset({ contentHeight: 200, viewportHeight: 700, topInset: 100 }), -100);
  // Nearly fills the view: bottom-aligned, newest line in view.
  assert.equal(newestScrollOffset({ contentHeight: 650, viewportHeight: 700, topInset: 100 }), -50);
  // Not laid out yet.
  assert.equal(newestScrollOffset({ contentHeight: 200, viewportHeight: 0, topInset: 100 }), null);
});

test("multi-lead: hint, delivery line, subtitle and picker list every lead", () => {
  assert.equal(segmentsText(composerHint("", group2, names)), "To Wallace, Peggy Olson (leads) · @name or @all for others");
  assert.equal(segmentsText(composerHint("@scrat date?", group2, names)), "To Scrat + Wallace, Peggy Olson (leads) · Assign or task: sends it to their main chat");
  assert.equal(segmentsText(composerHint("@peggy copy?", group2, names)), "To Peggy Olson + Wallace (lead) · Assign or task: sends it to their main chat");
  assert.equal(segmentsText(composerHint("@scrat go", group2, names, { assign: true })), "To Scrat + Wallace, Peggy Olson (leads) · task goes to their main chat");
  assert.equal(deliveryLine(msg("user", "launch?", { to: ["wallace", "peggy"] }), group2, names), "Wallace, Peggy Olson (leads)");
  assert.equal(deliveryLine(msg("user", "@scrat date?", { to: ["scrat", "wallace", "peggy"] }), group2, names), "Scrat + Wallace, Peggy Olson (leads)");
  assert.equal(groupSubtitle(group, names), "3 bots · lead Wallace");
  assert.equal(groupSubtitle(group2, names), "3 bots · leads Wallace, Peggy Olson");
  const rows = pickerRows("", group2, names, []);
  assert.deepEqual(rows.map((r) => (r.kind === "member" ? `${r.id}:${r.lead}` : r.id)), ["wallace:true", "peggy:true", "scrat:false", "all"]);
});

test("sendButton: like the bot-chat composer, hidden until there is text; spinner and disabled while sending", () => {
  assert.equal(sendButton("", false), "hidden");
  assert.equal(sendButton("   \n ", false), "hidden");
  assert.equal(sendButton("hi", false), "send");
  assert.equal(sendButton("  hi ", false), "send");
  assert.equal(sendButton("hi", true), "sending");
  // The draft stays while it posts; even if it were cleared the spinner shows until the post ends.
  assert.equal(sendButton("", true), "sending");
});

test("hasMarkdown: bot messages with markdown go to the host renderer; plain ones keep the @mention highlight", () => {
  for (const md of [
    "The plan is **ship Monday**.",
    "| Day | Task |\n|---|---|\n| Mon | ship |",
    "## Plan\nship",
    "Steps:\n- copy\n- art",
    "1. copy\n2. art",
    "Run `npm test` first",
    "See [the doc](https://example.com/doc)",
    "> quoted",
    "```\ncode\n```",
  ]) {
    assert.equal(hasMarkdown(md), true, md);
  }
  for (const plain of ["@scrat can you write the copy?", "Ship on 3 Nov.", "2 * 3 = 6", "a - b", "snake_case_name and 5*4"]) {
    assert.equal(hasMarkdown(plain), false, plain);
  }
});
