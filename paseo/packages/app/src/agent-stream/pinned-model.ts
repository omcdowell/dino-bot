import type { DeliveryState } from "@/components/delivery-tick";
import type { OutboxRecord } from "@/stores/outbox-store";

export interface PinnedMessage {
  key: string;
  clientMessageId: string;
  text: string;
  createdAt: number;
  state: DeliveryState;
  /** Only in the daemon queue (sent from another device). */
  remote: boolean;
  record: OutboxRecord | null;
}

export interface DaemonQueueItem {
  messageId: string;
  text: string;
  createdAt: string;
}

export function resolvePinnedDeliveryState(
  record: OutboxRecord,
  daemonHolds: boolean,
): DeliveryState | null {
  switch (record.state) {
    case "cancelling":
      return null;
    case "outbox":
      return daemonHolds ? "queued" : "clock";
    case "received":
      return daemonHolds ? "queued" : "single";
    case "queued":
      return "queued";
    case "taken":
      return "taken";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
  }
}

/** Joins the outbox with the daemon queue, minus everything whose canonical row is in the stream. */
export function buildPinnedMessages(input: {
  records: readonly OutboxRecord[];
  daemonQueue: readonly DaemonQueueItem[];
  inStream: ReadonlySet<string>;
}): PinnedMessage[] {
  const held = new Set(input.daemonQueue.map((item) => item.messageId));
  const own = new Set(input.records.map((record) => record.clientMessageId));
  const pinned: PinnedMessage[] = [];
  for (const record of input.records) {
    if (input.inStream.has(record.clientMessageId)) continue;
    const state = resolvePinnedDeliveryState(record, held.has(record.clientMessageId));
    if (!state) continue;
    pinned.push({
      key: record.clientMessageId,
      clientMessageId: record.clientMessageId,
      text: record.text,
      createdAt: record.createdAt,
      state,
      remote: false,
      record,
    });
  }
  for (const item of input.daemonQueue) {
    if (own.has(item.messageId) || input.inStream.has(item.messageId)) continue;
    pinned.push({
      key: item.messageId,
      clientMessageId: item.messageId,
      text: item.text,
      createdAt: Date.parse(item.createdAt) || 0,
      state: "queued",
      remote: true,
      record: null,
    });
  }
  return pinned.sort((a, b) => a.createdAt - b.createdAt);
}

/** A user row in the loaded stream, as far as matching pinned bubbles needs it. */
export interface StreamUserRow {
  clientMessageId?: string;
  text: string;
  /** Epoch ms; NaN when unknown. */
  timestamp: number;
}

/** How far the app has the agent's timeline: the daemon's timeline epoch and the newest seq loaded. */
export interface LoadedTimelineEnd {
  epoch: string;
  endSeq: number;
}

/**
 * Taken messages whose canonical row the app's timeline has reached, by the row's position.
 *
 * When the daemon takes a message it says where the agent's row for it is (found by the
 * message's client message ID: `record.row`). Once the loaded timeline reaches that seq, the
 * row is either loaded (and matched by ID) or above the loaded page: the app came back after
 * more than a page of rows and the catch-up jumped to the latest tail
 * (`viewed-timeline-sync.ts`, fallbackToLatestTailOnOverflow), or a cold start loaded only the
 * tail. Either way the message is in the chat's history and leaves the pinned list; before
 * this, its bubble stayed pinned under every later reply, as if sent last (build 18).
 *
 * A different epoch means the daemon rebuilt the timeline after it took the message (a restart
 * replays the agent's history): the row is in that history, or comes with its ID when the agent
 * runs the message, so the bubble goes too.
 */
export function takenRecordsReachedByTimeline(
  records: readonly OutboxRecord[],
  loaded: LoadedTimelineEnd | null | undefined,
  alreadyInStream: ReadonlySet<string> = new Set(),
): string[] {
  if (!loaded) return [];
  return records
    .filter(
      (record) =>
        record.state === "taken" &&
        record.row !== undefined &&
        !alreadyInStream.has(record.clientMessageId) &&
        (record.row.epoch !== loaded.epoch || record.row.seq <= loaded.endSeq),
    )
    .map((record) => record.clientMessageId);
}

/** Taken messages the daemon gave no row position for (`record.row`): older daemons. */
export function takenRecordsWithoutRow(records: readonly OutboxRecord[]): OutboxRecord[] {
  return records.filter((record) => record.state === "taken" && record.row === undefined);
}

// COMPAT(msgRowPosition): the two rules below are for taken messages from daemons that do not
// send the row position (send_agent_message_response.row, added after v0.1.16) and whose
// history rows lack client message IDs. Remove after 2027-03-01.

/** Phone and daemon clocks may disagree; a row this much older than the send still counts. */
export const TAKEN_TEXT_MATCH_SKEW_MS = 10 * 60 * 1000;

/**
 * Taken messages (no row position) whose canonical row is older than the loaded stream, by
 * time: a taken message sent before every loaded row has its row above the loaded page.
 * `oldestLoadedRowAt` is NaN when nothing is loaded: then nothing is settled.
 */
export function takenRecordsOlderThanStream(
  records: readonly OutboxRecord[],
  oldestLoadedRowAt: number,
  alreadyInStream: ReadonlySet<string> = new Set(),
): string[] {
  if (!Number.isFinite(oldestLoadedRowAt)) return [];
  return takenRecordsWithoutRow(records)
    .filter(
      (record) =>
        !alreadyInStream.has(record.clientMessageId) &&
        (record.sentAt ?? record.createdAt) < oldestLoadedRowAt,
    )
    .map((record) => record.clientMessageId);
}

/**
 * Taken messages (no row position) whose canonical row is in the stream without its client
 * message ID: an older daemon rebuilt the timeline from history that did not keep the IDs.
 * Each row settles at most one message; newer messages take newer rows. Rows that carry a
 * client message ID belong to that send and are never used here.
 */
export function matchTakenRecordsByText(
  records: readonly OutboxRecord[],
  rows: readonly StreamUserRow[],
  alreadyInStream: ReadonlySet<string> = new Set(),
): string[] {
  const taken = takenRecordsWithoutRow(records)
    .filter((record) => !alreadyInStream.has(record.clientMessageId))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (taken.length === 0) return [];
  const used = new Set<number>();
  const matched: string[] = [];
  for (const record of taken) {
    const text = record.text.trim();
    if (!text) continue;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (used.has(index)) continue;
      const row = rows[index];
      if (row.clientMessageId) continue;
      if (row.text.trim() !== text) continue;
      if (
        Number.isFinite(row.timestamp) &&
        row.timestamp < record.createdAt - TAKEN_TEXT_MATCH_SKEW_MS
      ) {
        continue;
      }
      used.add(index);
      matched.push(record.clientMessageId);
      break;
    }
  }
  return matched;
}
