import { describe, expect, test } from "vitest";
import type { OutboxRecord } from "@/stores/outbox-store";
import {
  buildPinnedMessages,
  matchTakenRecordsByText,
  TAKEN_TEXT_MATCH_SKEW_MS,
  takenRecordsOlderThanStream,
  takenRecordsReachedByTimeline,
  takenRecordsWithoutRow,
} from "./pinned-model";

function record(id: string, state: OutboxRecord["state"], createdAt: number): OutboxRecord {
  return {
    serverId: "srv",
    agentId: "agent",
    clientMessageId: id,
    text: id,
    images: [],
    attachments: [],
    composerAttachments: [],
    activeTurnBehavior: "queue",
    createdAt,
    attempts: 1,
    everOnWire: true,
    nextAttemptAt: 0,
    state,
  };
}

test("pinned bubbles keep send order and show the tick for each state", () => {
  const pinned = buildPinnedMessages({
    records: [record("a", "outbox", 1), record("b", "received", 2), record("c", "queued", 3)],
    daemonQueue: [],
    inStream: new Set(),
  });
  expect(pinned.map((message) => [message.text, message.state])).toEqual([
    ["a", "clock"],
    ["b", "single"],
    ["c", "queued"],
  ]);
});

test("a bubble leaves the pinned list as soon as its canonical row is in the stream", () => {
  const records = [record("a", "taken", 1), record("b", "queued", 2)];
  expect(
    buildPinnedMessages({ records, daemonQueue: [], inStream: new Set(["a"]) }).map((m) => m.text),
  ).toEqual(["b"]);
});

test("the daemon queue turns a message grey and shows other devices' queued messages", () => {
  const pinned = buildPinnedMessages({
    records: [record("mine", "received", 1_000)],
    daemonQueue: [
      { messageId: "mine", text: "mine", createdAt: new Date(1_000).toISOString() },
      { messageId: "theirs", text: "theirs", createdAt: new Date(2_000).toISOString() },
    ],
    inStream: new Set(),
  });
  expect(pinned.map((message) => [message.text, message.state, message.remote])).toEqual([
    ["mine", "queued", false],
    ["theirs", "queued", true],
  ]);
});

test("a message being deleted is hidden at once", () => {
  expect(
    buildPinnedMessages({
      records: [record("gone", "cancelling", 1)],
      daemonQueue: [],
      inStream: new Set(),
    }),
  ).toEqual([]);
});

describe("taken messages whose canonical row lost its client message ID", () => {
  // Sam, 2026-10-13: "once's thats done send the build" was taken at 20:05, the daemon
  // restarted at 20:07 and replayed the chat from pi's history without client message IDs, so
  // the blue-ticked bubble stayed pinned under the chat, below later replies.
  const sentAt = Date.parse("2026-10-13T12:05:14Z");
  const taken = { ...record("cmid-1", "taken", sentAt), text: "once's thats done send the build" };

  test("settles against the replayed row with the same text", () => {
    const rows = [
      { text: "can you also make dino 50% bigger", timestamp: sentAt - 60_000 },
      { text: "once's thats done send the build", timestamp: sentAt + 11_000 },
      { text: "[dm from worker:dark-green]", timestamp: sentAt + 30_000 },
    ];
    expect(matchTakenRecordsByText([taken], rows)).toEqual(["cmid-1"]);
    expect(
      buildPinnedMessages({
        records: [taken],
        daemonQueue: [],
        inStream: new Set(matchTakenRecordsByText([taken], rows)),
      }),
    ).toEqual([]);
  });

  test("only taken messages are matched by text", () => {
    const rows = [{ text: "hello", timestamp: 2 }];
    for (const state of ["outbox", "received", "queued", "failed", "unknown"] as const) {
      expect(matchTakenRecordsByText([{ ...record("m", state, 1), text: "hello" }], rows)).toEqual(
        [],
      );
    }
  });

  test("ignores rows that carry a client message ID and rows from long before the send", () => {
    const mine = { ...record("m", "taken", 1_000_000_000), text: "yes" };
    expect(
      matchTakenRecordsByText(
        [mine],
        [
          { text: "yes", clientMessageId: "other-send", timestamp: 1_000_000_500 },
          { text: "yes", timestamp: 1_000_000_000 - TAKEN_TEXT_MATCH_SKEW_MS - 1 },
        ],
      ),
    ).toEqual([]);
  });

  test("each row settles one message, newest message takes the newest row", () => {
    const first = { ...record("first", "taken", 1_000), text: "yes" };
    const second = { ...record("second", "taken", 2_000), text: "yes" };
    expect(matchTakenRecordsByText([first, second], [{ text: "yes", timestamp: 2_500 }])).toEqual([
      "second",
    ]);
    expect(
      matchTakenRecordsByText(
        [first, second],
        [
          { text: "yes", timestamp: 1_500 },
          { text: "yes", timestamp: 2_500 },
        ],
      ).sort(),
    ).toEqual(["first", "second"]);
  });

  test("skips messages already settled by ID and trims whitespace", () => {
    const a = { ...record("a", "taken", 1), text: " go " };
    expect(matchTakenRecordsByText([a], [{ text: "go", timestamp: 2 }], new Set(["a"]))).toEqual(
      [],
    );
    expect(matchTakenRecordsByText([a], [{ text: "go", timestamp: Number.NaN }])).toEqual(["a"]);
  });
});

describe("taken messages whose canonical row is older than the loaded stream (MO1)", () => {
  test("settles a taken message sent before every loaded row", () => {
    const records = [{ ...record("old", "taken", 1_000), sentAt: 2_000 }];
    expect(takenRecordsOlderThanStream(records, 5_000)).toEqual(["old"]);
  });

  test("keeps it while the loaded stream reaches back to or past the send", () => {
    const records = [{ ...record("live", "taken", 1_000), sentAt: 2_000 }];
    expect(takenRecordsOlderThanStream(records, 2_000)).toEqual([]);
    expect(takenRecordsOlderThanStream(records, 1_500)).toEqual([]);
  });

  test("settles nothing when no row is loaded", () => {
    expect(takenRecordsOlderThanStream([record("x", "taken", 1)], Number.NaN)).toEqual([]);
  });

  test("only taken messages: one the agent has not taken stays pinned", () => {
    const records = (["outbox", "received", "queued", "failed", "unknown"] as const).map((state) =>
      record(state, state, 1),
    );
    expect(takenRecordsOlderThanStream(records, 5_000)).toEqual([]);
  });

  test("skips messages already settled by ID or text", () => {
    expect(
      takenRecordsOlderThanStream([record("seen", "taken", 1)], 5_000, new Set(["seen"])),
    ).toEqual([]);
  });
});

describe("taken messages settled by the row position the daemon returned (MO2)", () => {
  function withRow(id: string, epoch: string, seq: number): OutboxRecord {
    return { ...record(id, "taken", 1), row: { epoch, seq } };
  }

  test("settles once the loaded timeline reaches the row, even if the row is not loaded", () => {
    const records = [withRow("m", "e1", 120)];
    // Build 18, 2026-11-20: the app came back to the latest 40 rows (150..190); row 120 is above them.
    expect(takenRecordsReachedByTimeline(records, { epoch: "e1", endSeq: 190 })).toEqual(["m"]);
    expect(takenRecordsReachedByTimeline(records, { epoch: "e1", endSeq: 120 })).toEqual(["m"]);
  });

  test("stays pinned while the loaded timeline ends before the row", () => {
    expect(
      takenRecordsReachedByTimeline([withRow("m", "e1", 120)], { epoch: "e1", endSeq: 119 }),
    ).toEqual([]);
  });

  test("settles when the daemon rebuilt its timeline (new epoch) after taking the message", () => {
    expect(
      takenRecordsReachedByTimeline([withRow("m", "e1", 120)], { epoch: "e2", endSeq: 3 }),
    ).toEqual(["m"]);
  });

  test("settles nothing before the app has loaded any timeline", () => {
    expect(takenRecordsReachedByTimeline([withRow("m", "e1", 1)], undefined)).toEqual([]);
    expect(takenRecordsReachedByTimeline([withRow("m", "e1", 1)], null)).toEqual([]);
  });

  test("ignores records that are not taken, have no row, or are already in the stream", () => {
    const loaded = { epoch: "e1", endSeq: 999 };
    const queued: OutboxRecord = { ...record("q", "queued", 1), row: { epoch: "e1", seq: 1 } };
    expect(takenRecordsReachedByTimeline([queued], loaded)).toEqual([]);
    expect(takenRecordsReachedByTimeline([record("legacy", "taken", 1)], loaded)).toEqual([]);
    expect(
      takenRecordsReachedByTimeline([withRow("seen", "e1", 1)], loaded, new Set(["seen"])),
    ).toEqual([]);
  });

  test("only taken records without a row fall back to the text and time rules", () => {
    const records = [withRow("new", "e1", 1), record("old", "taken", 1), record("q", "queued", 1)];
    expect(takenRecordsWithoutRow(records).map((r) => r.clientMessageId)).toEqual(["old"]);
  });
});
