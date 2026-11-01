import { test } from "node:test";
import assert from "node:assert/strict";
import type { Group } from "../shared/rooms/schema";
import { assign, assignmentText, ownTask, postHint, sentLine, stripMentions } from "../server/rooms/assign";
import { setUserName } from "../shared/party";

// Prompts and notices name the user from the settings; these tests use a configured name.
setUserName("Sam");

const GROUP: Group = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], leads: ["wallace"] };
const NAMES = { wallace: "Wallace", scrat: "Scrat", peggy: "Peggy Carter" };
const MSG = "01K6ZQ5V8M00000000000000AA";

function fakeDeps(opts: { openFails?: boolean; sendFails?: boolean } = {}) {
  const calls: string[] = [];
  const sent: Array<{ agentId: string; text: string; opts: unknown }> = [];
  const deps = {
    async openChat(bot: string) {
      calls.push(`open:${bot}`);
      if (opts.openFails) throw new Error("no profile");
      return { agentId: `agent-${bot}` };
    },
    async send(agentId: string, text: string, o: { messageId: string; activeTurnBehavior: "steer" }) {
      calls.push(`send:${agentId}`);
      if (opts.sendFails) throw new Error("daemon said no");
      sent.push({ agentId, text, opts: o });
    },
  };
  return { deps, calls, sent };
}

test("assignmentText: header line then the text without the @mention", () => {
  assert.equal(
    assignmentText(GROUP, "user", "@wallace task: set the launch date", MSG),
    `[room alarm-clock task from user msg ${MSG}]\ntask: set the launch date\n${postHint("alarm-clock", MSG)}`,
  );
});

test("postHint: the task ends with the exact bot-room post command, group and msg id filled in", () => {
  const text = assignmentText(GROUP, "user", "@wallace task: set the launch date", MSG);
  const last = text.split("\n").at(-1)!;
  assert.equal(last, postHint("alarm-clock", MSG));
  assert.ok(last.includes(`bot-room post alarm-clock --re ${MSG} --text "..."`), last);
  assert.match(last, /finish this task, or get stuck on it/);
  assert.match(last, /no progress updates/);
  // The header stays the first line, so pi-optchat's ROOM_LEAD_TASK still files a lead's task as dm:<lead>.
  const lead = assignmentText(GROUP, "wallace", "@Peggy task: draft", MSG, NAMES);
  assert.match(lead, /^\[room alarm-clock task from wallace msg [^\]\n]*\]\n/);
  assert.ok(lead.endsWith(postHint("alarm-clock", MSG)));
});

test("stripMentions: addressing mentions by id or first name, @all/@everyone, trailing comma", () => {
  assert.equal(stripMentions("@Wallace, task: ring at 7", GROUP), "task: ring at 7");
  assert.equal(stripMentions("@peggy task: copy", GROUP), "task: copy");
  assert.equal(stripMentions("@Peggy task: copy", GROUP, NAMES), "task: copy");
  assert.equal(stripMentions("@scrat @Wallace: task: two", GROUP), "task: two");
  assert.equal(stripMentions("@all task: hi", GROUP), "task: hi");
  assert.equal(stripMentions("Morning. @wallace task: the date", GROUP), "Morning. task: the date");
  // A mention inside the task is content (who to work with), not addressing: kept.
  assert.equal(stripMentions("@wallace task: copy with @Peggy", GROUP, NAMES), "task: copy with @Peggy");
  // Not mentions: an e-mail address, a non-member, a longer word that starts with a member id.
  assert.equal(stripMentions("@wallace task: mail sam@x.com", GROUP), "task: mail sam@x.com");
  assert.equal(stripMentions("@wallace task: ask @gromit", GROUP), "task: ask @gromit");
  assert.equal(stripMentions("@wallace task: see @wallaceville", GROUP), "task: see @wallaceville");
});

test("stripMentions keeps line breaks and drops lines that held only a mention", () => {
  assert.equal(stripMentions("@wallace\ntask: one\n  two  ", GROUP), "task: one\ntwo");
});

test("assign: opens the main chat, then sends in steer mode with the room message id", async () => {
  const { deps, calls, sent } = fakeDeps();
  const result = await assign({ group: GROUP, bot: "wallace", messageId: MSG, text: "@wallace task: set the date" }, deps);
  assert.deepEqual(result, { agentId: "agent-wallace" });
  assert.deepEqual(calls, ["open:wallace", "send:agent-wallace"]);
  assert.deepEqual(sent, [
    {
      agentId: "agent-wallace",
      text: `[room alarm-clock task from user msg ${MSG}]\ntask: set the date\n${postHint("alarm-clock", MSG)}`,
      opts: { messageId: MSG, activeTurnBehavior: "steer" },
    },
  ]);
});

test("assign: a retry reuses the room message id as Paseo messageId (daemon dedupes)", async () => {
  const { deps, sent } = fakeDeps();
  const input = { group: GROUP, bot: "scrat", messageId: MSG, text: "@scrat task: acorns" };
  await assign(input, deps);
  await assign(input, deps);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((s) => (s.opts as { messageId: string }).messageId),
    [MSG, MSG],
  );
  assert.equal(sent[0].text, sent[1].text);
});

test("assign: failure rejects, so the caller writes no 'sent' line", async () => {
  const ledger: string[] = [];
  const run = async (deps: ReturnType<typeof fakeDeps>["deps"]) => {
    const { agentId } = await assign({ group: GROUP, bot: "peggy", messageId: MSG, text: "@peggy task: copy" }, deps);
    ledger.push(sentLine("Peggy") + ` ${agentId}`);
  };

  const openFail = fakeDeps({ openFails: true });
  await assert.rejects(run(openFail.deps), /no profile/);
  assert.deepEqual(openFail.calls, ["open:peggy"], "send is never tried when open fails");

  const sendFail = fakeDeps({ sendFails: true });
  await assert.rejects(run(sendFail.deps), /daemon said no/);
  assert.deepEqual(ledger, []);
});

test("assign: refuses non-members and empty tasks before touching Paseo", async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(assign({ group: GROUP, bot: "gromit", messageId: MSG, text: "@gromit task: x" }, deps), /not a member/);
  await assert.rejects(assign({ group: GROUP, bot: "wallace", messageId: MSG, text: "  @wallace  " }, deps), /Empty task/);
  await assert.rejects(assign({ group: GROUP, bot: "wallace", messageId: "", text: "@wallace task: x" }, deps), /messageId/);
  assert.deepEqual(calls, []);
});

test("sentLine names the bot's main chat", () => {
  assert.equal(sentLine("Wallace"), "Sent to Wallace's main chat");
});

test("lead task: header names the lead and says it is not from Sam and not his approval; sentLine names the lead", async () => {
  assert.equal(
    assignmentText(GROUP, "wallace", "@Peggy task: draft the copy", MSG, NAMES),
    [
      `[room alarm-clock task from wallace msg ${MSG}]`,
      "(From Wallace, a lead bot of the group, not from Sam. It is not Sam's approval: anything that needs Sam's approval still needs it.)",
      "task: draft the copy",
      postHint("alarm-clock", MSG),
    ].join("\n"),
  );
  const { deps, sent } = fakeDeps();
  await assign({ group: GROUP, bot: "peggy", messageId: MSG, text: "@Peggy task: draft", names: NAMES, from: "wallace" }, deps);
  assert.match(sent[0]!.text, /^\[room alarm-clock task from wallace msg [^\]]+\]\n\(From Wallace, a lead bot of the group, not from Sam\./);
  assert.equal(sentLine("Peggy", "Wallace"), "Sent to Peggy's main chat (from Wallace)");
  assert.equal(sentLine("Peggy"), "Sent to Peggy's main chat");
});

test("lead task: a non-lead bot, the lead to itself, or an empty task is refused before touching Paseo", async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(assign({ group: GROUP, bot: "peggy", messageId: MSG, text: "@peggy task: x", from: "scrat" }, deps), /Only a lead/);
  await assert.rejects(assign({ group: GROUP, bot: "wallace", messageId: MSG, text: "@wallace task: x", from: "wallace" }, deps), /itself/);
  await assert.rejects(assign({ group: GROUP, bot: "peggy", messageId: MSG, text: "@peggy", from: "wallace" }, deps), /Empty task/);
  assert.deepEqual(calls, []);
});

test("ownTask: a lead's multi-line delegation gives each member the preamble and only its own task lines (visual-bugs 4, PF1)", async () => {
  const text = [
    "Plan for the launch:",
    "@Scrat task: write the store copy,",
    "  three lines max.",
    "@Peggy task: draw the icon",
    "@Wallace task: no, nothing for me",
  ].join("\n");
  assert.equal(ownTask(text, "scrat", GROUP, NAMES), "Plan for the launch:\n\n@Scrat task: write the store copy,\n  three lines max.");
  assert.equal(ownTask(text, "peggy", GROUP, NAMES), "Plan for the launch:\n\n@Peggy task: draw the icon");
  // PF1: a multi-line preamble goes to each member unchanged and in order; an @mention in it (no task:) is not a part.
  const pre = "Goal: ship v2 by Friday.\n  @Peggy and @Scrat, keep it short.\n\n@Scrat task: copy\n@Peggy task: icon";
  assert.equal(ownTask(pre, "scrat", GROUP, NAMES), "Goal: ship v2 by Friday.\n  @Peggy and @Scrat, keep it short.\n\n@Scrat task: copy");
  assert.equal(ownTask(pre, "peggy", GROUP, NAMES), "Goal: ship v2 by Friday.\n  @Peggy and @Scrat, keep it short.\n\n@Peggy task: icon");
  // Preamble on the same line as the first part.
  assert.equal(ownTask("Today: @scrat task: copy @peggy task: art", "peggy", GROUP), "Today:\n\n@peggy task: art");
  // No preamble: own parts only, as in c2882fd.
  assert.equal(ownTask("@scrat task: copy\n@peggy task: art", "scrat", GROUP), "@scrat task: copy");
  // A member tasked without a part of its own (Assign toggle on a plain @mention) gets the whole message.
  const toggle = "Context.\n@scrat task: copy\n@peggy task: art\n@wallace have a look too";
  assert.equal(ownTask(toggle, "wallace", GROUP), toggle);
  // One line, two tasks; a shared part goes to both; parts for one bot are joined in order.
  assert.equal(ownTask("@scrat task: copy @peggy task: art", "peggy", GROUP), "@peggy task: art");
  const shared = "@scrat @peggy task: agree a palette\n@peggy task: then the icon\n@scrat task: then the copy";
  assert.equal(ownTask(shared, "peggy", GROUP), "@scrat @peggy task: agree a palette\n@peggy task: then the icon");
  assert.equal(ownTask(shared, "scrat", GROUP), "@scrat @peggy task: agree a palette\n@scrat task: then the copy");
  // A single task (or the same members twice) is unchanged, lines before it included.
  for (const single of ["Context first.\n@scrat task: copy\nmore detail", "@scrat task: a\n@Scrat task: b", "@scrat @peggy do this"]) {
    assert.equal(ownTask(single, "scrat", GROUP, NAMES), single);
  }
  // Through assign: each main chat gets its own task, not the others'.
  const { deps, sent } = fakeDeps();
  await assign({ group: GROUP, bot: "scrat", messageId: MSG, text, names: NAMES, from: "wallace" }, deps);
  await assign({ group: GROUP, bot: "peggy", messageId: MSG, text, names: NAMES, from: "wallace" }, deps);
  assert.match(sent[0]!.text, /\ntask: write the store copy,\nthree lines max\.\n/);
  assert.match(sent[0]!.text, /\nPlan for the launch:\n\ntask: write the store copy,/);
  assert.doesNotMatch(sent[0]!.text, /icon/);
  assert.match(sent[1]!.text, /\nPlan for the launch:\n\ntask: draw the icon\n/);
  assert.doesNotMatch(sent[1]!.text, /store copy|nothing for me/);
});

test("ownTask: a run of mentions before task: is one part shared by every member in it (gc-final)", () => {
  for (const run of ["@Scrat @Peggy", "@Scrat, @Peggy", "@Scrat and @Peggy"]) {
    const text = `Launch.\n${run} task: agree a palette\n@Wallace task: book the venue`;
    for (const bot of ["scrat", "peggy"]) {
      assert.equal(ownTask(text, bot, GROUP, NAMES), `Launch.\n\n${run} task: agree a palette`, `${run} / ${bot}`);
    }
    assert.equal(ownTask(text, "wallace", GROUP, NAMES), "Launch.\n\n@Wallace task: book the venue");
  }
  const three = "@wallace, @scrat and @peggy task: all of us\n@peggy task: the icon";
  assert.equal(ownTask(three, "scrat", GROUP), "@wallace, @scrat and @peggy task: all of us");
  assert.equal(ownTask(three, "peggy", GROUP), three);
  // A non-member in the run does not stop the members in it.
  assert.equal(ownTask("@scrat @gromit task: a\n@peggy task: b", "scrat", GROUP), "@scrat @gromit task: a");
});

test("stripMentions: only the run that introduces a task: goes; preamble lines keep their @mentions (gc-final)", () => {
  // Runs of 2 and 3, space / comma / "and" separated.
  for (const run of ["@scrat @peggy", "@scrat, @peggy", "@scrat and @peggy", "@wallace @scrat @peggy", "@wallace, @scrat and @peggy", "@wallace, @scrat, and @peggy"]) {
    assert.equal(stripMentions(`${run} task: agree a palette`, GROUP), "task: agree a palette", run);
  }
  assert.equal(stripMentions("Today: @Scrat and @Peggy task: copy", GROUP, NAMES), "Today: task: copy");
  // A preamble line that starts with @mentions is kept whole (it used to arrive as "and @Peggy: launch Friday").
  const multi = "@Scrat and @Peggy: launch Friday\n@Scrat task: copy\n@Peggy task: icon";
  assert.equal(
    assignmentText(GROUP, "wallace", ownTask(multi, "scrat", GROUP, NAMES), MSG, NAMES).split("\n").slice(2, -1).join("\n"),
    "@Scrat and @Peggy: launch Friday\n\ntask: copy",
  );
  // Single-task messages keep their text the same way: only the task's own addressing goes.
  assert.equal(stripMentions("@Scrat and @Peggy: launch Friday\n@Scrat task: copy", GROUP, NAMES), "@Scrat and @Peggy: launch Friday\ntask: copy");
  assert.equal(stripMentions("@peggy, have a look first.\n@scrat task: copy\n@wallace ok?", GROUP), "@peggy, have a look first.\ntask: copy\n@wallace ok?");
  // A non-member in the run is not addressing: it stays.
  assert.equal(stripMentions("@scrat and @gromit task: x", GROUP), "@gromit task: x");
  // No task: part (Assign toggle): the run that opens the message is its addressing, "and" included.
  assert.equal(stripMentions("@Peggy and @scrat, sort the launch", GROUP, NAMES), "sort the launch");
  assert.equal(stripMentions("Context first.\n@peggy help him", GROUP), "Context first.\n@peggy help him");
});

