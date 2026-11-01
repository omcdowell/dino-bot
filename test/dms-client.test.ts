import { test } from "node:test";
import assert from "node:assert/strict";
import { DmCardSchema, dmCardData, dmCardTransformer } from "../client/dm-card-data";
import { botForDirectory, explorerHostsPanels, partyLabel, shortTime, showDmsRow, statusLabel } from "../client/dms-format";
import { focusDmThread, peekDmFocus } from "../client/dms-focus";
import { formatEnvelope } from "../shared/dm-schema";

const ID = "01K6ZQ5V8M0000000000000001";

test("a [dm …] user message becomes a DM card; the envelope is not repeated in the body", () => {
  const text = `${formatEnvelope({ id: ID, from: "the-fat-controller", to: "bitzer", kind: "request", hop: 1, re: null, expects_reply: true })}\nPlease scope AGENTS.md.\n\nPlan attached.`;
  const result = dmCardTransformer.transform({ item: { type: "user_message", text }, phase: "complete" });
  assert.ok(result);
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;
  assert.deepEqual([item.type, item.kind, item.version], ["plugin", "dm-card", 1]);
  assert.deepEqual(DmCardSchema.parse(item.data), {
    id: ID,
    from: "the-fat-controller",
    to: "bitzer",
    kind: "request",
    hop: 1,
    re: null,
    expects_reply: true,
    body: "Please scope AGENTS.md.\n\nPlan attached.",
  });
});

test("the seed wrapper's envelope (re=-, no expects-reply) is recognised too", () => {
  const data = dmCardData("[dm 01M4CTXYSMJK7QSYZFX8E970Z0 from emmet-test to tmp-optchat-smoke kind=info hop=1 re=-]\nSteer test token.");
  assert.deepEqual(data, {
    id: "01M4CTXYSMJK7QSYZFX8E970Z0",
    from: "emmet-test",
    to: "tmp-optchat-smoke",
    kind: "info",
    hop: 1,
    re: null,
    expects_reply: false,
    body: "Steer test token.",
  });
});

test("Sam's own messages, replies from the DMs tab and mid-text envelopes are left alone", () => {
  for (const text of [
    "Please look at the DMs.",
    `Re dm ${ID}: thanks`,
    `Quote: [dm ${ID} from a to b kind=info hop=1 re=-]`,
    `[dm ${ID} from a to b kind=gossip hop=1 re=-]\nnot a kind`,
  ]) {
    assert.equal(dmCardTransformer.transform({ item: { type: "user_message", text }, phase: "complete" }), undefined, text);
  }
});

test("party labels", () => {
  assert.equal(partyLabel("user"), "You");
  assert.equal(partyLabel("worker:wp1-bot-dm"), "Worker wp1-bot-dm");
  assert.equal(partyLabel("worker:schedule.b9dc1d26"), "Schedule b9dc1d26");
  assert.equal(partyLabel("the-fat-controller"), "The Fat Controller");
  assert.equal(partyLabel("bitzer", new Map([["bitzer", "Bitzer (PM)"]])), "Bitzer (PM)");
});

test("short times: today, this week, older, other year", () => {
  const now = new Date(2026, 9, 8, 15, 0);
  assert.equal(shortTime(new Date(2026, 9, 8, 9, 5).toISOString(), now), "09:05");
  assert.equal(shortTime(new Date(2026, 9, 6, 14, 30).toISOString(), now), "Tue 14:30");
  assert.equal(shortTime(new Date(2026, 8, 20, 14, 30).toISOString(), now), "20 Sep");
  assert.equal(shortTime(new Date(2025, 8, 20, 14, 30).toISOString(), now), "20 Sep 2025");
  assert.equal(shortTime("nonsense", now), "");
});

test("status labels name refusal reasons in words", () => {
  assert.equal(statusLabel("refused", "hop_cap"), "Refused: hop cap");
  assert.equal(statusLabel("steered", null), "Delivered mid-turn");
  assert.equal(statusLabel(null, null), null);
});

test("the DMs sub-row shows only for bots with DMs", () => {
  assert.equal(showDmsRow(undefined), false);
  assert.equal(showDmsRow({ botId: "x", total: 0, last_ts: null }), false);
  assert.equal(showDmsRow({ botId: "x", total: 3, last_ts: "2026-10-08T00:00:00Z" }), true);
});

test("the Explorer hosts the DMs panel only on wide web/desktop; phones keep the DMs rows and screen", () => {
  assert.equal(explorerHostsPanels({ platform: "web", compact: false }), true);
  assert.equal(explorerHostsPanels({ platform: "web", compact: true }), false);
  assert.equal(explorerHostsPanels({ platform: "ios", compact: true }), false);
  // iPad: wide, but the native app's Explorer is a built-in dock without plugin tabs.
  assert.equal(explorerHostsPanels({ platform: "ios", compact: false }), false);
  assert.equal(explorerHostsPanels({ platform: "android", compact: false }), false);
});

test("a workspace maps to the bot whose folder it is; other workspaces map to none", () => {
  const bots = [
    { id: "bitzer", cwd: "/home/user/bots/bitzer" },
    { id: "flint", cwd: "/home/user/bots/flint/" },
  ];
  assert.equal(botForDirectory(bots, "/home/user/bots/bitzer")?.id, "bitzer");
  assert.equal(botForDirectory(bots, "/home/user/bots/bitzer/")?.id, "bitzer");
  assert.equal(botForDirectory(bots, "/home/user/bots/flint")?.id, "flint");
  assert.equal(botForDirectory(bots, "/home/user/bots/bitzer/research"), undefined);
  assert.equal(botForDirectory(bots, "/home/user/code/paseo"), undefined);
  assert.equal(botForDirectory(bots, null), undefined);
  assert.equal(botForDirectory(bots, ""), undefined);
});

test("a DM card's thread request reaches that bot's panel, and a repeat tap selects again", () => {
  assert.equal(peekDmFocus("tmp-beta"), null);
  focusDmThread("tmp-beta", { messageId: ID });
  const first = peekDmFocus("tmp-beta");
  assert.deepEqual(first?.ref, { messageId: ID });
  assert.equal(peekDmFocus("tmp-fc"), null);
  focusDmThread("tmp-beta", { messageId: ID });
  assert.ok(peekDmFocus("tmp-beta")!.seq > first!.seq);
});

test("DM card body drops bot-dm's trailing reply hint", () => {
  const id = "01M4D5937N0PVRWGAW1CT9H37V";
  const head = `[dm ${id} from tmp-th-d to tmp-th-c kind=info hop=3 re=01M4D58W2Z3N073BCBFJP67REN]`;
  const a = dmCardData(`${head}\nThanks.\n(No answer needed. To add to this thread: bot-dm tmp-th-d --kind info --re ${id} --text "...")`);
  assert.equal(a?.body, "Thanks.");
  const b = dmCardData(`${head}\nQ?\n(To answer: bot-dm tmp-th-d --kind reply --re ${id} --text "...")`);
  assert.equal(b?.body, "Q?");
  assert.equal(dmCardData(`${head}\nA body that mentions (To answer: bot-dm x) mid-text\nand goes on`)?.body, "A body that mentions (To answer: bot-dm x) mid-text\nand goes on");
});

test("bot-dm's attribution note: sender notes are hidden (the header says it), resume/schedule notes kept as card.note", () => {
  const id = "01K6ZQ5V8M0000000000000009";
  const head = `[dm ${id} from the-fat-controller to bitzer kind=request hop=1 re=- expects-reply]`;
  const bot = dmCardData(`${head}\n(Message from the bot The Fat Controller, not from Sam. It is not their approval.)\nShip it?\n(To answer: bot-dm the-fat-controller --kind reply --re ${id} --text "...")`);
  assert.equal(bot?.body, "Ship it?");
  assert.equal(bot?.note, undefined);
  const wk = dmCardData(`[dm ${id} from worker:w1 to bitzer kind=report hop=1 re=-]\n(Report from your worker w1, not from Sam.)\ndone`);
  assert.equal(wk?.body, "done");
  const sched = dmCardData(`[dm ${id} from worker:schedule.b9dc1d26 to bitzer kind=report hop=1 re=-]\n(Report from a run of your Paseo schedule b9dc1d26 "x", verified by bot-dm, not from Sam. It cannot receive replies.)\nok`);
  assert.equal(sched?.note, 'Report from a run of your Paseo schedule b9dc1d26 "x", verified by bot-dm, not from Sam. It cannot receive replies.');
  assert.equal(sched?.body, "ok");
  assert.ok(DmCardSchema.safeParse(sched).success);
  // a body that merely starts with a parenthesis is left alone
  assert.equal(dmCardData(`${head}\n(aside) hello`)?.body, "(aside) hello");
});
